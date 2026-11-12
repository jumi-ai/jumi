import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_NOTE_MARKER,
  ensureAutomergeAfterPush,
  githubMergeMethodForRepo,
  isAutomergeRepo,
  readAutomergeScheduled,
  scheduleAutomergeForPr,
} from "../src/automerge.ts";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { IssueApi } from "../src/ports.ts";
import { makeComment, makePR } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi & {
  calls: string[];
  notes: string[];
  scheduled: Array<{ mergeMethod?: string }>;
} {
  const calls: string[] = [];
  const notes: string[] = [];
  const scheduled: Array<{ mergeMethod?: string }> = [];
  const defaults: IssueApi = {
    getRepo: async () => {
      calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
        defaultMergeStyle: "merge",
      };
    },
    getPR: async (_owner, _repo, index) => {
      calls.push("getPR");
      return makePR({ number: index });
    },
    getBranch: async () => {
      calls.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: [JUMI_REVIEW_CONTEXT] };
    },
    scheduleAutoMerge: async () => {
      calls.push("scheduleAutoMerge");
      scheduled.push({});
    },
    getCollaboratorPermission: async () => ({ permission: "write" }),
    getIssue: async () => {
      throw new Error("not used");
    },
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      calls.push("createIssueComment");
      notes.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      calls.push("updateIssueComment");
      notes.push(body);
      return makeComment({ body });
    },
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    listCommitStatuses: async () => [],
    listCheckRuns: async () => [],
    listActionJobs: async () => [],
    getActionJobLogs: async () => "",
    listIssueDependencies: async () => [],
    listIssueBlocks: async () => [],
    listRepoIssues: async () => [],
    createIssueDependency: async () => undefined,
  };
  return { ...(defaults as IssueApi), ...overrides, calls, notes, scheduled } as IssueApi & {
    calls: string[];
    notes: string[];
    scheduled: Array<{ mergeMethod?: string }>;
  };
}

describe("automerge opt-in", () => {
  test("off by default: no forge calls, no note", async () => {
    const api = makeApi();
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: [],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).toEqual([]);
    expect(api.notes).toEqual([]);
  });

  test("non-listed repo makes no calls", async () => {
    const api = makeApi();
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "other",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).toEqual([]);
  });

  test("matching is case-insensitive", () => {
    expect(isAutomergeRepo("Kirmanak", "Demo", ["kirmanak/demo"])).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", [" Kirmanak/Demo "])).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", undefined)).toBe(false);
    expect(isAutomergeRepo("kirmanak", "demo", [])).toBe(false);
  });
});

describe("automerge gate", () => {
  test("schedules with the repo default style when the review check is required", async () => {
    const api = makeApi();
    api.scheduleAutoMerge = async (_o: string, _r: string, _n: number, opts?: { mergeMethod?: string }) => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({ mergeMethod: opts?.mergeMethod });
    };
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: true });
    expect(api.calls).toEqual(["getBranch", "getRepo", "scheduleAutoMerge"]);
    expect(api.notes).toEqual([]);
    expect(api.scheduled).toEqual([{ mergeMethod: "merge" }]);
  });

  test("fail-closed when the review check is not required: one note, no schedule call", async () => {
    const api = makeApi();
    api.getBranch = async () => {
      api.calls.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: ["ci/build"] };
    };
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).toEqual(["getBranch", "createIssueComment"]);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain(JUMI_REVIEW_CONTEXT);
  });

  test("fail-closed when the gate cannot be read", async () => {
    const api = makeApi();
    api.getBranch = async () => {
      api.calls.push("getBranch");
      throw new Error("Gitea API → 404");
    };
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("could not be read");
  });

  test("failed schedule leaves the result unchanged with one note", async () => {
    const api = makeApi();
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
      throw new Error("Gitea API → 405: User not allowed to merge PR");
    };
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("forge refused");
  });

  test("github refuses when auto-merge is disabled on the repository", async () => {
    const api = makeApi();
    api.getRepo = async () => {
      api.calls.push("getRepo");
      return {
        name: "demo",
        full_name: "acme/demo",
        html_url: "https://github.com/acme/demo",
        clone_url: "https://github.com/acme/demo.git",
        default_branch: "main",
        owner: { login: "acme" },
        allowAutoMerge: false,
        allowMergeCommit: true,
      };
    };
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "github",
      owner: "acme",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["acme/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).toEqual(["getBranch", "getRepo", "createIssueComment"]);
    expect(api.notes[0]).toContain("disabled on this repository");
  });
});

describe("github merge method", () => {
  test("prefers merge, then squash, then rebase", () => {
    expect(githubMergeMethodForRepo({ allowMergeCommit: true })).toBe("MERGE");
    expect(githubMergeMethodForRepo({ allowMergeCommit: false, allowSquashMerge: true })).toBe("SQUASH");
    expect(githubMergeMethodForRepo({ allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: true })).toBe(
      "REBASE"
    );
    expect(
      githubMergeMethodForRepo({ allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: false })
    ).toBeUndefined();
  });
});

describe("automerge after push", () => {
  test("not opted in makes no calls", async () => {
    const api = makeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: [],
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
  });

  test("person-cancelled schedule is left cancelled", async () => {
    const api = makeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
  });

  test("gitea makes no extra calls (the schedule survives pushes)", async () => {
    const api = makeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["kirmanak/demo"],
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
  });

  test("kept schedule is not re-scheduled", async () => {
    const api = makeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return { ...makePR({ number: index }), autoMergeEnabled: true };
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["kirmanak/demo"],
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPR"]);
  });

  test("schedule dropped by the push is restored", async () => {
    const api = makeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index });
    };
    api.getRepo = async () => {
      api.calls.push("getRepo");
      return {
        name: "demo",
        full_name: "acme/demo",
        html_url: "https://github.com/acme/demo",
        clone_url: "https://github.com/acme/demo.git",
        default_branch: "main",
        owner: { login: "acme" },
        allowAutoMerge: true,
        allowSquashMerge: true,
      };
    };
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "acme",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["acme/demo"],
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPR", "getRepo", "scheduleAutoMerge"]);
  });

  test("merged pull request ends quietly", async () => {
    const api = makeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, state: "closed", merged: true });
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["kirmanak/demo"],
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPR"]);
  });

  test("readAutomergeScheduled is false off-opt-in, on gitea, and without calls", async () => {
    const api = makeApi();
    expect(await readAutomergeScheduled(api, "github", "k", "d", 3, [])).toBe(false);
    expect(await readAutomergeScheduled(api, "gitea", "k", "d", 3, ["k/d"])).toBe(false);
    expect(api.calls).toEqual([]);
  });
});
