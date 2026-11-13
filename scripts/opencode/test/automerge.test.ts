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

type TestApi = IssueApi & {
  getPRFiles: (
    owner: string,
    repo: string,
    index: number
  ) => Promise<
    Array<{
      filename: string;
      status: "added" | "modified" | "changed" | "deleted" | "renamed";
      additions: number;
      deletions: number;
      changes: number;
    }>
  >;
  getRepoFile: (
    owner: string,
    repo: string,
    path: string,
    ref: string
  ) => Promise<{ found: boolean; content?: string }>;
  cancelAutoMerge: (owner: string, repo: string, index: number) => Promise<boolean>;
};

function makeApi(overrides: Partial<TestApi> = {}): TestApi & {
  calls: string[];
  notes: string[];
  scheduled: Array<{ mergeMethod?: string }>;
} {
  const calls: string[] = [];
  const notes: string[] = [];
  const scheduled: Array<{ mergeMethod?: string }> = [];
  const defaults: TestApi = {
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
    getPRFiles: async () => {
      calls.push("getPRFiles");
      return [];
    },
    getRepoFile: async () => {
      calls.push("getRepoFile");
      return { found: true, content: "automerge: true\n" };
    },
    cancelAutoMerge: async () => {
      calls.push("cancelAutoMerge");
      return true;
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
  return { ...defaults, ...overrides, calls, notes, scheduled } as TestApi & {
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

  test("whole-owner entries allow every repository of that owner", () => {
    expect(isAutomergeRepo("acme", "api", ["acme"])).toBe(true);
    expect(isAutomergeRepo("acme", "api", ["ACME"])).toBe(true);
    expect(isAutomergeRepo("acme", "api", ["acme/*"])).toBe(true);
    expect(isAutomergeRepo("acme", "api", ["other"])).toBe(false);
    expect(isAutomergeRepo("acme", "api", ["other/*"])).toBe(false);
    expect(isAutomergeRepo("acme", "api", ["acme/api/extra"])).toBe(false);
  });

  test("every-repository entries allow all repositories", () => {
    expect(isAutomergeRepo("acme", "api", ["*"])).toBe(true);
    expect(isAutomergeRepo("acme", "api", ["*/*"])).toBe(true);
    expect(isAutomergeRepo("acme", "api", [" * "])).toBe(true);
    expect(isAutomergeRepo("acme", "api", ["other/repo"])).toBe(false);
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getBranch", "getRepo", "scheduleAutoMerge"]);
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getBranch", "createIssueComment"]);
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
    // The forge request line stays in the server log, never in the public note.
    expect(api.notes[0]).not.toContain("Gitea API");
    expect(api.notes[0]).not.toContain("User not allowed");
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getBranch", "getRepo", "createIssueComment"]);
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
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
  });

  test("person-cancelled schedule is left cancelled without extra calls", async () => {
    const api = makeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
    expect(api.notes).toEqual([]);
  });

  test("a touching pull without a prior schedule stays silent", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: ".jumi.yml", status: "added", additions: 1, deletions: 0, changes: 1 }];
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("gitea without a settings touch makes no schedule calls", async () => {
    const api = makeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPRFiles", "getRepo", "getRepoFile"]);
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
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
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPRFiles", "getPR", "getRepo", "getRepoFile"]);
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
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
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPRFiles", "getPR", "getRepo", "getRepoFile", "scheduleAutoMerge"]);
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
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual(["getPRFiles", "getPR"]);
  });

  test("readAutomergeScheduled is false off-opt-in, on gitea, and without calls", async () => {
    const api = makeApi();
    expect(await readAutomergeScheduled(api, "github", "k", "d", 3, [])).toBe(false);
    expect(await readAutomergeScheduled(api, "gitea", "k", "d", 3, ["k/d"])).toBe(false);
    expect(api.calls).toEqual([]);
  });
});

function scheduleInput(api: ReturnType<typeof makeApi>, overrides: Record<string, unknown> = {}) {
  return {
    api,
    forgeKind: "gitea" as const,
    owner: "kirmanak",
    repo: "demo",
    prNumber: 3,
    baseBranch: "main",
    automergeRepos: ["kirmanak/demo"],
    botUsername: "jumi",
    log: () => undefined,
    ...overrides,
  };
}

describe("automerge repository settings file", () => {
  test("missing file schedules nothing with no note", async () => {
    const api = makeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile"]);
  });

  test("automerge off schedules nothing with no note", async () => {
    const api = makeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
  });

  test("invalid file schedules nothing and the note names the parser error", async () => {
    const api = makeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: yes-please\n" };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("is invalid");
    expect(api.notes[0]).toContain('"automerge" must be a boolean');
  });

  test("unreadable file fails closed with a note", async () => {
    const api = makeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      throw new Error("GitHub API → 500");
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("could not be read");
  });

  test("a pull that changes the settings file is not scheduled", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: ".jumi.yml", status: "added", additions: 1, deletions: 0, changes: 1 }];
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("changes the repository settings file");
  });

  test("a nested .jumi.yml does not block scheduling", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "docs/.jumi.yml", status: "added", additions: 1, deletions: 0, changes: 1 }];
    };
    api.scheduleAutoMerge = async (_o: string, _r: string, _n: number, opts?: { mergeMethod?: string }) => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({ mergeMethod: opts?.mergeMethod });
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: true });
  });

  test("a pull with a file matching review_exclude is not scheduled with one note", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "generated/bundle.js", status: "modified", additions: 10, deletions: 2, changes: 12 }];
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: 'automerge: true\nreview_exclude:\n  - "**/generated/**"\n' };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("`generated/bundle.js`");
    expect(api.notes[0]).toContain("a person needs to merge");
  });

  test("a pull with review_exclude patterns but no matching file is scheduled", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "src/app.ts", status: "modified", additions: 10, deletions: 2, changes: 12 }];
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: 'automerge: true\nreview_exclude:\n  - "**/generated/**"\n' };
    };
    api.scheduleAutoMerge = async (_o: string, _r: string, _n: number, opts?: { mergeMethod?: string }) => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({ mergeMethod: opts?.mergeMethod });
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: true });
    expect(api.notes).toEqual([]);
  });

  test("no review_exclude schedules a matching pull as today", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "src/app.ts", status: "modified", additions: 10, deletions: 2, changes: 12 }];
    };
    api.scheduleAutoMerge = async (_o: string, _r: string, _n: number, opts?: { mergeMethod?: string }) => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({ mergeMethod: opts?.mergeMethod });
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: true });
    expect(api.notes).toEqual([]);
  });

  test("unreadable pull files fail closed with a note and no schedule call", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      throw new Error("Gitea API → 500");
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).not.toContain("getRepoFile");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("could not be read");
  });
});

describe("automerge settings after push", () => {
  function restoreInput(api: ReturnType<typeof makeApi>, overrides: Record<string, unknown> = {}) {
    return {
      api,
      forgeKind: "github" as const,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
      ...overrides,
    };
  }

  test("a push that brings the settings file in cancels the schedule with one note", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: ".jumi.yml", status: "added", additions: 2, deletions: 0, changes: 2 }];
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return { ...makePR({ number: index }), autoMergeEnabled: true };
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).toContain("cancelAutoMerge");
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("cancelled");
    expect(api.notes[0]).toContain(".jumi.yml");
  });

  test("a push adding a matching file to a scheduled pull cancels with one note", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "pnpm-lock.yaml", status: "modified", additions: 20, deletions: 5, changes: 25 }];
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index });
    };
    api.getRepo = async () => {
      api.calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
        allowAutoMerge: true,
        allowSquashMerge: true,
      };
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: 'automerge: true\nreview_exclude:\n  - "pnpm-lock.yaml"\n' };
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).toContain("cancelAutoMerge");
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("`pnpm-lock.yaml`");
    expect(api.notes[0]).toContain("a person needs to merge");
  });

  test("a push with review_exclude patterns but no matching file restores as today", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: "src/app.ts", status: "modified", additions: 10, deletions: 2, changes: 12 }];
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index });
    };
    api.getRepo = async () => {
      api.calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
        allowAutoMerge: true,
        allowSquashMerge: true,
      };
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: 'automerge: true\nreview_exclude:\n  - "**/generated/**"\n' };
    };
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).toContain("scheduleAutoMerge");
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("an invalid default-branch file is not restored and the note names the error", async () => {
    const api = makeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index });
    };
    api.getRepo = async () => {
      api.calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
        defaultMergeStyle: "merge",
      };
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: 1\n" };
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("is invalid");
  });

  test("a settings file turned off is not restored with no note", async () => {
    const api = makeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index });
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("unreadable pull files after a push neither cancel nor restore", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      throw new Error("GitHub API → 500");
    };
    await ensureAutomergeAfterPush(restoreInput(api));
    expect(api.calls).toEqual(["getPRFiles"]);
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("gitea touching pull with a removed schedule posts the cancelled note", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: ".jumi.yml", status: "added", additions: 1, deletions: 0, changes: 1 }];
    };
    api.cancelAutoMerge = async () => {
      api.calls.push("cancelAutoMerge");
      return true;
    };
    await ensureAutomergeAfterPush(restoreInput(api, { forgeKind: "gitea" as const, wasScheduled: false }));
    expect(api.calls).toContain("cancelAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("cancelled");
  });

  test("gitea touching pull with nothing to remove stays silent", async () => {
    const api = makeApi();
    api.getPRFiles = async () => {
      api.calls.push("getPRFiles");
      return [{ filename: ".jumi.yml", status: "added", additions: 1, deletions: 0, changes: 1 }];
    };
    api.cancelAutoMerge = async () => {
      api.calls.push("cancelAutoMerge");
      return false;
    };
    await ensureAutomergeAfterPush(restoreInput(api, { forgeKind: "gitea" as const, wasScheduled: false }));
    expect(api.calls).toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
  });
});
