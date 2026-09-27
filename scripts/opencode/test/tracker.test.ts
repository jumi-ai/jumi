import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementIssue, issueJobKey } from "../src/implement.ts";
import type { Forge, Task } from "../src/ports.ts";
import { type ReviewApi, reviewPullRequest } from "../src/review.ts";
import { issueJobFromRecord, MemoryReviewJobStore, workerJobKey } from "../src/review_jobs.ts";
import {
  type BriefTracker,
  MISSING_REPOSITORY_COMMENT,
  makeExternalIssueJob,
  parseRepositoryLines,
  type TrackerRef,
  trackerRefOfJob,
} from "../src/tracker.ts";
import type { GitRunner } from "../src/workspace.ts";
import { emptyCiMethods, makeComment, makePR, makeRepo, makeUser } from "./fixtures.ts";

/** Fake tracker used only in tests. Supplies a brief and exactly one repository. Not a forge. */
function makeFakeTracker(opts: { comments?: string[]; canComment?: boolean } = {}): BriefTracker & {
  comments: string[];
  refs: TrackerRef[];
} {
  const comments: string[] = opts.comments ?? [];
  const refs: TrackerRef[] = [];
  const canComment = opts.canComment ?? true;
  const tracker: BriefTracker & { comments: string[]; refs: TrackerRef[] } = {
    kind: "fake",
    comments,
    refs,
  };
  if (canComment) {
    tracker.postBriefComment = async (ref: TrackerRef, body: string) => {
      refs.push(ref);
      comments.push(body);
    };
  }
  return tracker;
}

function makeForgeMock(calls: { method: string; args: unknown[] }[] = []): Forge & {
  calls: { method: string; args: unknown[] }[];
  pulls: unknown[];
} {
  const pulls: unknown[] = [];
  const forge = {
    calls,
    pulls,
    getRepo: async () => {
      calls.push({ method: "getRepo", args: [] });
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo",
        clone_url: "https://gitea.kirmanak.stream/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
      };
    },
    getPR: async (_owner: string, _repo: string, index: number) => {
      calls.push({ method: "getPR", args: [index] });
      return {
        forgeRef: String(index),
        number: index,
        title: "Add feature",
        body: "PR body",
        state: "open" as const,
        html_url: `https://gitea.kirmanak.stream/kirmanak/demo/pulls/${index}`,
        user: { login: "alice" },
        head: { ref: "feature", sha: "headsha", repo: null },
        base: { ref: "main", sha: "basesha" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      };
    },
    listOpenPulls: async () => {
      calls.push({ method: "listOpenPulls", args: [] });
      return [];
    },
    getCollaboratorPermission: async () => {
      calls.push({ method: "getCollaboratorPermission", args: [] });
      return { permission: "write" as const };
    },
    createPullRequest: async (
      owner: string,
      repo: string,
      pull: { title: string; body: string; head: string; base: string }
    ) => {
      calls.push({ method: "createPullRequest", args: [owner, repo, pull] });
      pulls.push({ owner, repo, pull });
      return {
        forgeRef: "3",
        number: 3,
        title: pull.title,
        body: pull.body,
        state: "open" as const,
        html_url: `https://gitea.kirmanak.stream/${owner}/${repo}/pulls/3`,
        user: { login: "jumi" },
        head: { ref: pull.head, sha: "headsha", repo: null },
        base: { ref: pull.base, sha: "basesha" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      };
    },
    closePullRequest: async (_o: string, _r: string, index: number) => {
      calls.push({ method: "closePullRequest", args: [index] });
      throw new Error("not implemented");
    },
    reopenPullRequest: async () => {
      throw new Error("not implemented");
    },
    updatePullRequestBody: async () => {
      throw new Error("not implemented");
    },
    getPRFiles: async () => {
      calls.push({ method: "getPRFiles", args: [] });
      return [];
    },
    listIssueComments: async () => {
      calls.push({ method: "listIssueComments", args: [] });
      return [];
    },
    findStickyIssueComment: async () => {
      calls.push({ method: "findStickyIssueComment", args: [] });
      return undefined;
    },
    createIssueComment: async () => {
      calls.push({ method: "createIssueComment", args: [] });
      throw new Error("forge issue must not be created for an external brief");
    },
    updateIssueComment: async () => {
      calls.push({ method: "updateIssueComment", args: [] });
      throw new Error("forge issue must not be updated for an external brief");
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (
      _o: string,
      _r: string,
      _s: string,
      status: { state: "pending" | "success" | "error" | "failure" | "warning" }
    ) => {
      calls.push({ method: "createCommitStatus", args: [status] });
      return status;
    },
    listCommitStatuses: async () => [{ status: "success" as const }],
    listCheckRuns: async () => [],
    listActionJobs: async () => [],
    getActionJobLogs: async () => "",
    getIssue: async () => {
      calls.push({ method: "getIssue", args: [] });
      throw new Error("fake stable id must not be treated as a forge issue number");
    },
    listIssueDependencies: async () => [],
    listIssueBlocks: async () => [],
    listRepoIssues: async () => [],
    createIssueDependency: async () => {
      calls.push({ method: "createIssueDependency", args: [] });
      throw new Error("must not record blocked-by for an external brief");
    },
  } as unknown as Forge & { calls: { method: string; args: unknown[] }[]; pulls: unknown[] };
  return forge;
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-tracker-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-tracker-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("tracker reference", () => {
  test("live jobs keep their integer identity while core can lease by tracker ref", () => {
    const live = {
      delivery: "d1",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      action: "assigned",
      title: "Fix",
      body: "Body",
      htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
      issueUpdatedAt: "2026-05-23T00:00:00Z",
      defaultBranch: "main",
      cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      receivedAt: "2026-05-23T00:00:00Z",
    };
    const ref = trackerRefOfJob(live);
    expect(ref.id).toBe("12");
    expect(ref.url).toBe(live.htmlUrl);
    expect(workerJobKey(live)).toBe("implement:kirmanak/demo#12");
    expect(issueJobKey(live)).toBe("kirmanak/demo#12");
  });

  test("parses exactly one Repository line and refuses several jobs", () => {
    expect(parseRepositoryLines("Fix it\n\nRepository: kirmanak/demo\n")).toEqual([
      { owner: "kirmanak", repo: "demo" },
    ]);
    expect(parseRepositoryLines("no repo here")).toEqual([]);
    expect(
      parseRepositoryLines("Repository: a/one\nRepository: b/two\n")
        .map((r) => `${r.owner}/${r.repo}`)
        .sort()
    ).toEqual(["a/one", "b/two"]);
  });

  test("missing-repository comment is one line asking for Repository: owner/repo", () => {
    expect(MISSING_REPOSITORY_COMMENT.split("\n")).toHaveLength(1);
    expect(MISSING_REPOSITORY_COMMENT).toContain("Repository: owner/repo");
  });
});

describe("external first-run implement", () => {
  test("fake tracker (not a forge) enqueues and the parent opens the pull on the named repo", async () => {
    await withDirs(async (home, workdir) => {
      const tracker = makeFakeTracker();
      const forgeCalls: { method: string; args: unknown[] }[] = [];
      const forge = makeForgeMock(forgeCalls);
      expect(tracker).not.toBe(forge as unknown);
      expect("createPullRequest" in tracker).toBe(false);

      const job = makeExternalIssueJob({
        tracker: "fake",
        trackerId: "FAKE-123",
        trackerUrl: "https://tracker.example/items/FAKE-123",
        title: "Fix the thing",
        body: "Please implement this.\n\nRepository: kirmanak/demo\n",
        owner: "kirmanak",
        repo: "demo",
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      });
      expect(job.issueNumber).toBe(0);
      expect(job.trackerId).toBe("FAKE-123");

      const store = new MemoryReviewJobStore();
      const enqueued = await store.enqueueIssue(job);
      expect(enqueued.queued).toBe(true);
      expect(enqueued.key).toBe("implement:fake:FAKE-123");
      expect(enqueued.key).not.toContain("#12");

      const leased = await store.lease("worker-1", 60_000, new Date(), ["implement"]);
      expect(leased).toBeDefined();
      const leasedJob = issueJobFromRecord(leased!);
      expect(leasedJob.tracker).toBe("fake");
      expect(leasedJob.trackerId).toBe("FAKE-123");
      expect(leasedJob.trackerUrl).toBe("https://tracker.example/items/FAKE-123");

      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/fake-fake-123-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };

      const result = await implementIssue({
        api: forge as unknown as Parameters<typeof implementIssue>[0]["api"],
        tracker: tracker as unknown as Parameters<typeof implementIssue>[0]["tracker"],
        forge: forge as unknown as Parameters<typeof implementIssue>[0]["forge"],
        job: leasedJob,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });

      expect(result.status).toBe("pr");
      expect(forge.pulls).toHaveLength(1);
      const opened = forge.pulls[0] as {
        owner: string;
        repo: string;
        pull: { head: string; base: string; body: string };
      };
      expect(opened.owner).toBe("kirmanak");
      expect(opened.repo).toBe("demo");
      expect(opened.pull.base).toBe("main");
      expect(opened.pull.head).toContain("fake-fake-123");
      expect(opened.pull.head).not.toContain("issue-12");
      expect(opened.pull.body).not.toContain("Fixes #");
      expect(opened.pull.body).toContain("https://tracker.example/items/FAKE-123");
      const forgeIssueCalls = forgeCalls.filter((c) => c.method === "getIssue" || c.method === "createIssueComment");
      expect(forgeIssueCalls).toEqual([]);
    });
  });

  test("zero repositories posts one Repository comment and never starts the engine", async () => {
    await withDirs(async (home, workdir) => {
      const tracker = makeFakeTracker();
      const forge = makeForgeMock();
      const job = makeExternalIssueJob({
        tracker: "fake",
        trackerId: "FAKE-124",
        trackerUrl: "https://tracker.example/items/FAKE-124",
        title: "Missing repo",
        body: "No repository named here.",
        owner: "",
        repo: "",
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      });
      let engineRan = false;
      const result = await implementIssue({
        api: forge as unknown as Parameters<typeof implementIssue>[0]["api"],
        tracker: tracker as unknown as Parameters<typeof implementIssue>[0]["tracker"],
        forge: forge as unknown as Parameters<typeof implementIssue>[0]["forge"],
        job,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git must not run without exactly one repository");
        },
        openCodeRunner: async () => {
          engineRan = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(engineRan).toBe(false);
      expect(result.status).toBe("skipped");
      expect(forge.pulls).toHaveLength(0);
      expect(tracker.comments).toHaveLength(1);
      expect(tracker.comments[0]!.split("\n")).toHaveLength(1);
      expect(tracker.comments[0]).toContain("Repository: owner/repo");
      expect(tracker.refs[0]).toEqual({
        tracker: "fake",
        id: "FAKE-124",
        url: "https://tracker.example/items/FAKE-124",
      });
    });
  });

  test("more than one repository is a refusal, not several jobs", async () => {
    await withDirs(async (home, workdir) => {
      const tracker = makeFakeTracker();
      const forge = makeForgeMock();
      const job = makeExternalIssueJob({
        tracker: "fake",
        trackerId: "FAKE-125",
        trackerUrl: "https://tracker.example/items/FAKE-125",
        title: "Two repos",
        body: "Repository: kirmanak/demo\nRepository: kirmanak/other\n",
        owner: "kirmanak",
        repo: "demo",
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      });
      let engineRan = false;
      const result = await implementIssue({
        api: forge as unknown as Parameters<typeof implementIssue>[0]["api"],
        tracker: tracker as unknown as Parameters<typeof implementIssue>[0]["tracker"],
        forge: forge as unknown as Parameters<typeof implementIssue>[0]["forge"],
        job,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git must not run for a multi-repo refusal");
        },
        openCodeRunner: async () => {
          engineRan = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(engineRan).toBe(false);
      expect(result.status).toBe("skipped");
      expect(forge.pulls).toHaveLength(0);
      expect(tracker.comments).toHaveLength(1);
    });
  });

  test("a tracker that cannot take a comment records the skip on the job", async () => {
    await withDirs(async (home, workdir) => {
      const tracker = makeFakeTracker({ canComment: false });
      const forge = makeForgeMock();
      const job = makeExternalIssueJob({
        tracker: "fake",
        trackerId: "FAKE-126",
        trackerUrl: "https://tracker.example/items/FAKE-126",
        title: "No comment channel",
        body: "No repository named here.",
        owner: "",
        repo: "",
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      });
      let engineRan = false;
      const result = await implementIssue({
        api: forge as unknown as Parameters<typeof implementIssue>[0]["api"],
        tracker: tracker as unknown as Parameters<typeof implementIssue>[0]["tracker"],
        forge: forge as unknown as Parameters<typeof implementIssue>[0]["forge"],
        job,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git must not run");
        },
        openCodeRunner: async () => {
          engineRan = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(engineRan).toBe(false);
      expect(result).toEqual({ status: "skipped", reason: "missing Repository: owner/repo" });
      expect(forge.pulls).toHaveLength(0);
    });
  });
});

describe("implement and review take tracker and forge separately", () => {
  test("review uses the tracker for issues and the forge for pulls", async () => {
    const trackerCalls: string[] = [];
    const forgeCalls: string[] = [];
    const trackerApi = {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write" as const }),
      getPR: async () => {
        trackerCalls.push("getPR");
        return makePR();
      },
      getPRFiles: async () => [],
      getIssue: async (): Promise<Task> => {
        trackerCalls.push("getIssue");
        return {
          trackerRef: "12",
          number: 12,
          title: "Fix the thing",
          body: "Please implement this.",
          state: "open" as const,
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          user: makeUser(),
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        };
      },
      listIssueComments: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _i: number, body: string) => makeComment({ body }),
      updateIssueComment: async (_o: string, _r: string, id: number, body: string) => makeComment({ id, body }),
      listPullReviewComments: async () => [],
      listPullReviews: async () => [],
      createPullReview: async () => ({ id: 1 }),
      submitPullReview: async () => ({ id: 1 }),
      resolvePullComment: async () => undefined,
      unresolvePullComment: async () => undefined,
      dismissPullReview: async () => ({ id: 1 }),
      createCommitStatus: async (
        _o: string,
        _r: string,
        _s: string,
        status: { state: "pending" | "success" | "error" | "failure" | "warning" }
      ) => status,
      ...emptyCiMethods(),
      listCommitStatuses: async () => [{ status: "success" as const }],
    } as unknown as ReviewApi;
    const forgeApi = {
      ...(trackerApi as unknown as Record<string, unknown>),
      getPR: async () => {
        forgeCalls.push("getPR");
        return makePR({ title: "Fix", body: "Fixes #12" });
      },
      getIssue: async (): Promise<Task> => {
        forgeCalls.push("getIssue");
        return {
          trackerRef: "12",
          number: 12,
          title: "Fix the thing",
          body: "Please implement this.",
          state: "open" as const,
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          user: makeUser(),
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        };
      },
    } as unknown as ReviewApi;
    expect(trackerApi).not.toBe(forgeApi);

    const workspace = await mkdtemp(join(tmpdir(), "jumi-tracker-review-"));
    try {
      await writeFile(join(workspace, "JUMI_REVIEW.md"), "No blocking issues.\n<!-- jumi-check: success -->\n");
      const result = await reviewPullRequest({
        api: forgeApi,
        tracker: trackerApi,
        forge: forgeApi,
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        expectedHeadSha: "headsha",
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner: async (args) => {
          const a = [...args];
          while (a[0] === "-c") a.splice(0, 2);
          if (a[0] === "ls-files") return "";
          if (a[0] === "rev-parse") return "headsha";
          if (a[0] === "status") return "?? JUMI_REVIEW.md";
          return "";
        },
        openCodeRunner: async () => ({ status: "ok" }),
        inspectOtherChecks: false,
        logger: () => undefined,
      });
      expect(result.status).toBe("posted");
      expect(forgeCalls).toContain("getPR");
      expect(trackerCalls).toContain("getIssue");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("live git-host adapter still satisfies both when passed as both", async () => {
    await withDirs(async (home, workdir) => {
      const calls: string[] = [];
      const both = {
        getRepo: async () => {
          calls.push("getRepo");
          return {
            name: "demo",
            full_name: "kirmanak/demo",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo",
            clone_url: "https://gitea.kirmanak.stream/kirmanak/demo.git",
            default_branch: "main",
            owner: { login: "kirmanak" },
          };
        },
        getCollaboratorPermission: async () => ({ permission: "write" as const }),
        getIssue: async () => {
          calls.push("getIssue");
          return {
            trackerRef: "12",
            number: 12,
            title: "Fix the thing",
            body: "Please implement this.",
            state: "open" as const,
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
            user: makeUser(),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
          };
        },
        getPR: async (_o: string, _r: string, index: number) => makePR({ number: index }),
        listOpenPulls: async () => [],
        createPullRequest: async (
          _o: string,
          _r: string,
          pull: { title: string; body: string; head: string; base: string }
        ) => {
          calls.push("createPullRequest");
          return makePR({ number: 3, title: pull.title, body: pull.body });
        },
        closePullRequest: async (_o: string, _r: string, index: number) => makePR({ number: index, state: "closed" }),
        updatePullRequestBody: async (_o: string, _r: string, index: number, body: string) =>
          makePR({ number: index, body }),
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o: string, _r: string, _i: number, body: string) => makeComment({ body }),
        updateIssueComment: async (_o: string, _r: string, id: number, body: string) => makeComment({ id, body }),
        listIssueComments: async () => [],
        listPullReviewComments: async () => [],
        listPullReviews: async () => [],
        ...emptyCiMethods(),
      } as unknown as Parameters<typeof implementIssue>[0]["api"];
      const job = {
        delivery: "d1",
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        action: "assigned",
        title: "Fix the thing",
        body: "Please implement this.",
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
        receivedAt: "2026-05-23T00:00:00Z",
      };
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api: both,
        tracker: both,
        forge: both,
        job,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(calls).toContain("createPullRequest");
    });
  });
});
