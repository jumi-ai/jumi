import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_NOTE_MARKER,
  AUTOMERGE_REFUSED_MARKER,
  ensureAutomergeAfterPush,
  githubMergeMethodForRepo,
  isAutomergeRepo,
  readAutomergeScheduled,
  scheduleAutomergeForPr,
} from "../src/automerge.ts";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { IssueApi } from "../src/ports.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeBranch, makeComment, makePR, makeUser } from "./fixtures.ts";

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

function automergeApi(overrides: Partial<TestApi> = {}): TestApi & {
  calls: string[];
  notes: string[];
  scheduled: Array<{ mergeMethod?: string }>;
} {
  const calls: string[] = [];
  const notes: string[] = [];
  const scheduled: Array<{ mergeMethod?: string }> = [];
  const {
    getPRFiles: getPRFilesOverride,
    getRepo: getRepoOverride,
    getPR: getPROverride,
    getIssue: getIssueOverride,
    getRepoFile: getRepoFileOverride,
    cancelAutoMerge: cancelAutoMergeOverride,
    getBranch: getBranchOverride,
    scheduleAutoMerge: scheduleAutoMergeOverride,
    createIssueComment: createIssueCommentOverride,
    updateIssueComment: updateIssueCommentOverride,
    getCollaboratorPermission: getCollaboratorPermissionOverride,
    ...rest
  } = overrides;
  const fake = makeIssueApi({
    getIssue:
      getIssueOverride ??
      (async () => {
        throw new Error("not used");
      }),
    getRepo:
      getRepoOverride ??
      (async () => {
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
      }),
    getPR:
      getPROverride ??
      (async (_owner: string, _repo: string, index: number) => {
        calls.push("getPR");
        return makePR({ number: index });
      }),
    getRepoFile:
      getRepoFileOverride ??
      (async () => {
        calls.push("getRepoFile");
        return { found: true, content: "automerge: true\n" };
      }),
    cancelAutoMerge:
      cancelAutoMergeOverride ??
      (async () => {
        calls.push("cancelAutoMerge");
        return true;
      }),
    getBranch:
      getBranchOverride ??
      (async () => {
        calls.push("getBranch");
        return { protected: true, enableStatusCheck: true, requiredContexts: [JUMI_REVIEW_CONTEXT] };
      }),
    scheduleAutoMerge:
      scheduleAutoMergeOverride ??
      (async () => {
        calls.push("scheduleAutoMerge");
        scheduled.push({});
      }),
    getCollaboratorPermission: getCollaboratorPermissionOverride ?? (async () => ({ permission: "write" })),
    createIssueComment:
      createIssueCommentOverride ??
      (async (_owner: string, _repo: string, _index: number, body: string) => {
        calls.push("createIssueComment");
        notes.push(body);
        return makeComment({ body });
      }),
    updateIssueComment:
      updateIssueCommentOverride ??
      (async (_owner: string, _repo: string, _id: number, body: string) => {
        calls.push("updateIssueComment");
        notes.push(body);
        return makeComment({ body });
      }),
    ...rest,
  });
  const api = fake as unknown as TestApi & {
    calls: string[];
    notes: string[];
    scheduled: Array<{ mergeMethod?: string }>;
  };
  if (getPRFilesOverride) {
    (api as unknown as Record<string, unknown>)["getPRFiles"] = getPRFilesOverride;
  } else {
    (api as unknown as Record<string, unknown>)["getPRFiles"] = async () => {
      calls.push("getPRFiles");
      return [];
    };
  }
  return Object.assign(api, { calls, notes, scheduled });
}

describe("automerge opt-in", () => {
  test("deployment switch off with file off stays quiet", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: [],
      automergeEnabled: false,
      botUsername: "jumi",
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
  });

  test("non-listed repo with file off stays quiet", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
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
    expect(api.notes).toEqual([]);
  });

  test("matching is case-insensitive", () => {
    expect(isAutomergeRepo("Kirmanak", "Demo", ["kirmanak/demo"])).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", [" Kirmanak/Demo "])).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", undefined)).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", [])).toBe(true);
    expect(isAutomergeRepo("kirmanak", "demo", ["other/repo"])).toBe(false);
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

describe("deployment-blocked automerge note", () => {
  function baseInput(api: ReturnType<typeof automergeApi>, overrides: Record<string, unknown> = {}) {
    return {
      api,
      forgeKind: "gitea" as const,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"] as readonly string[],
      botUsername: "jumi",
      log: () => undefined,
      ...overrides,
    };
  }

  function withAdmittedLabel(api: ReturnType<typeof automergeApi>) {
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    };
  }

  test("switch off + file true: one note + one log", async () => {
    const api = automergeApi();
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr(
      baseInput(api, { automergeEnabled: false, log: (m: string) => logs.push(m) })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_ENABLED");
    expect(api.notes[0]).toContain("deployer");
    expect(logs.filter((m) => m.includes("deployment switch off"))).toHaveLength(1);
  });

  test("not-listed + file true: one note + one log", async () => {
    const api = automergeApi();
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr(
      baseInput(api, { repo: "other", automergeRepos: ["kirmanak/demo"], log: (m: string) => logs.push(m) })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_REPOS");
    expect(api.notes[0]).toContain("deployer");
    expect(logs.filter((m) => m.includes("not in deployment allowlist"))).toHaveLength(1);
  });

  test("switch off + admitted label (file off): one note + one log", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    withAdmittedLabel(api);
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr(
      baseInput(api, { automergeEnabled: false, log: (m: string) => logs.push(m) })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_ENABLED");
    expect(logs.filter((m) => m.includes("deployment switch off"))).toHaveLength(1);
  });

  test("not-listed + admitted label (file off): one note + one log", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    withAdmittedLabel(api);
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr(
      baseInput(api, {
        repo: "other",
        automergeRepos: ["kirmanak/demo"],
        log: (m: string) => logs.push(m),
      })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_REPOS");
    expect(logs.filter((m) => m.includes("not in deployment allowlist"))).toHaveLength(1);
  });

  test("no note when file missing", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    const result = await scheduleAutomergeForPr(baseInput(api, { automergeEnabled: false }));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
    const api2 = automergeApi();
    api2.getRepoFile = async () => {
      api2.calls.push("getRepoFile");
      return { found: false };
    };
    const result2 = await scheduleAutomergeForPr(baseInput(api2, { repo: "other", automergeRepos: ["kirmanak/demo"] }));
    expect(result2).toEqual({ scheduled: false });
    expect(api2.notes).toEqual([]);
  });

  test("no note when file false and no label", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const result = await scheduleAutomergeForPr(baseInput(api, { automergeEnabled: false }));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
  });

  test("no note when no-automerge present, even with file true", async () => {
    const api = automergeApi();
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["no-automerge"] as never });
    };
    const result = await scheduleAutomergeForPr(baseInput(api, { automergeEnabled: false }));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
    const api2 = automergeApi();
    api2.getPR = async (_o: string, _r: string, index: number) => {
      api2.calls.push("getPR");
      return makePR({ number: index, labels: ["no-automerge"] as never });
    };
    const result2 = await scheduleAutomergeForPr(baseInput(api2, { repo: "other", automergeRepos: ["kirmanak/demo"] }));
    expect(result2).toEqual({ scheduled: false });
    expect(api2.notes).toEqual([]);
  });

  test("no note when automerge label untrusted", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "mallory" } }];
    };
    api.getCollaboratorPermission = async () => ({ permission: "read" });
    const result = await scheduleAutomergeForPr(
      baseInput(api, { automergeEnabled: false, trustedSenderLogins: ["alice"] })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
  });

  test("switch off + issue label admitted (via copy): one note + one log", async () => {
    const { scheduleAutomergeForNewPr } = await import("../src/automerge.ts");
    const api = automergeApi();
    api.getIssue = async () => {
      api.calls.push("getIssue");
      return { labels: ["automerge"], number: 12 } as never;
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    };
    const added: string[] = [];
    api.addIssueLabel = async (_o: string, _r: string, _n: number, label: string) => {
      api.calls.push("addIssueLabel");
      added.push(label);
      return {};
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const logs: string[] = [];
    const result = await scheduleAutomergeForNewPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      automergeEnabled: false,
      botUsername: "jumi",
      issueNumber: 12,
      log: (m: string) => logs.push(m),
    } as never);
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_ENABLED");
    expect(logs.filter((m) => m.includes("deployment switch off"))).toHaveLength(1);
  });

  test("not-listed + issue label admitted (via copy): one note + one log", async () => {
    const { scheduleAutomergeForNewPr } = await import("../src/automerge.ts");
    const api = automergeApi();
    api.getIssue = async () => {
      api.calls.push("getIssue");
      return { labels: ["automerge"], number: 12 } as never;
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    };
    api.addIssueLabel = async () => {
      api.calls.push("addIssueLabel");
      return {};
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const logs: string[] = [];
    const result = await scheduleAutomergeForNewPr({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "other",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      issueNumber: 12,
      log: (m: string) => logs.push(m),
    } as never);
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_REPOS");
    expect(logs.filter((m) => m.includes("not in deployment allowlist"))).toHaveLength(1);
  });
});

describe("automerge gate", () => {
  test("schedules with the repo default style when the review check is required", async () => {
    const api = automergeApi();
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getPR", "getBranch", "getRepo", "scheduleAutoMerge"]);
    expect(api.notes).toEqual([]);
    expect(api.scheduled).toEqual([{ mergeMethod: "merge" }]);
  });

  test("fail-closed when the review check is not required: one note, no schedule call", async () => {
    const api = automergeApi();
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getPR", "getBranch", "createIssueComment"]);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_NOTE_MARKER);
    expect(api.notes[0]).toContain(JUMI_REVIEW_CONTEXT);
  });

  test("fail-closed when the gate cannot be read", async () => {
    const api = automergeApi();
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
    const { AUTOMERGE_REFUSED_MARKER } = await import("../src/automerge.ts");
    const api = automergeApi();
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
    expect(api.notes[0]).toContain("forge refused (405: User not allowed to merge PR)");
    expect(api.notes[0]).toContain(AUTOMERGE_REFUSED_MARKER);
    expect(api.notes[0]).toContain("try again after its next push");
    // The forge request line stays in the server log, never in the public note.
    expect(api.notes[0]).not.toContain("Gitea API");
    expect(api.notes[0]).not.toContain("https://");
  });

  test("github refused schedule does not promise a push retry", async () => {
    const api = automergeApi({
      getRepo: async () => {
        api.calls.push("getRepo");
        return {
          name: "demo",
          full_name: "acme/demo",
          html_url: "https://github.com/acme/demo",
          clone_url: "https://github.com/acme/demo.git",
          default_branch: "main",
          owner: { login: "acme" },
          allowAutoMerge: true,
          allowMergeCommit: true,
        };
      },
    });
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
      throw new Error("GitHub API → 405: Auto-merge is not allowed");
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
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("forge refused (405: Auto-merge is not allowed)");
    expect(api.notes[0]).toContain(AUTOMERGE_REFUSED_MARKER);
    expect(api.notes[0]).not.toContain("try again after its next push");
  });

  test("github refuses when auto-merge is disabled on the repository", async () => {
    const api = automergeApi();
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
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getPR", "getBranch", "getRepo", "createIssueComment"]);
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
    const api = automergeApi();
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: true,
      automergeRepos: ["other/repo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).toEqual([]);
  });

  test("person-cancelled schedule is left cancelled without extra calls", async () => {
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    expect(api.calls).toEqual(["getPRFiles", "getPR", "getRepo", "getRepoFile"]);
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).not.toContain("cancelAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("kept schedule is not re-scheduled", async () => {
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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

  test("readAutomergeScheduled is false off-list, on gitea, and without calls", async () => {
    const api = automergeApi();
    expect(await readAutomergeScheduled(api, "github", "k", "d", 3, ["other/repo"])).toBe(false);
    expect(await readAutomergeScheduled(api, "gitea", "k", "d", 3, ["k/d"])).toBe(false);
    expect(api.calls).toEqual([]);
  });
});

function scheduleInput(api: ReturnType<typeof automergeApi>, overrides: Record<string, unknown> = {}) {
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
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
    expect(api.calls).toEqual(["getPRFiles", "getRepoFile", "getPR"]);
  });

  test("automerge off schedules nothing with no note", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    const result = await scheduleAutomergeForPr(scheduleInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.notes).toEqual([]);
  });

  test("invalid file schedules nothing and the note names the parser error", async () => {
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
  function restoreInput(api: ReturnType<typeof automergeApi>, overrides: Record<string, unknown> = {}) {
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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
    const api = automergeApi();
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

describe("automerge override labels", () => {
  function labelInput(api: ReturnType<typeof automergeApi>, overrides: Record<string, unknown> = {}) {
    return {
      api,
      forgeKind: "gitea" as const,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: undefined as readonly string[] | undefined,
      botUsername: "jumi",
      log: () => undefined,
      ...overrides,
    };
  }

  function withPrLabels(api: ReturnType<typeof automergeApi>, labels: Array<string | { name?: string }>) {
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: labels as never });
    };
  }

  function withTimeline(
    api: ReturnType<typeof automergeApi>,
    events: Array<{ label?: string | { name?: string }; actor?: string; user?: string; event?: string; type?: string }>
  ) {
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return events.map((entry) => ({
        ...(entry.event ? { event: entry.event } : {}),
        ...(entry.type ? { type: entry.type } : {}),
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.actor ? { actor: { login: entry.actor } } : {}),
        ...(entry.user ? { user: { login: entry.user } } : {}),
      }));
    };
  }

  test("unset deployer list still opts in by file alone", async () => {
    const api = automergeApi();
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    const result = await scheduleAutomergeForPr(labelInput(api, { automergeRepos: undefined }));
    expect(result).toEqual({ scheduled: true });
    expect(api.calls).toContain("scheduleAutoMerge");
  });

  test("non-empty deployer list still narrows even with the file on", async () => {
    const api = automergeApi();
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr(
      labelInput(api, { automergeRepos: ["other/repo"], log: (m: string) => logs.push(m) })
    );
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("JUMI_AUTOMERGE_REPOS");
    expect(logs.filter((m) => m.includes("not in deployment allowlist"))).toHaveLength(1);
  });

  test("switch off schedules nothing; automerge label gets the disabled note", async () => {
    const api = automergeApi();
    withPrLabels(api, ["automerge"]);
    withTimeline(api, [{ label: "automerge", actor: "alice", event: "labeled" }]);
    const result = await scheduleAutomergeForPr(labelInput(api, { automergeEnabled: false }));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("turned off");
  });

  test("label on issue copied to PR and scheduled with automerge:false", async () => {
    const api = automergeApi();
    api.getIssue = async () => {
      api.calls.push("getIssue");
      return { labels: ["automerge"], number: 12 } as never;
    };
    withTimeline(api, [{ label: "automerge", actor: "alice", event: "labeled" }]);
    const added: string[] = [];
    api.addIssueLabel = async (_o: string, _r: string, _n: number, label: string) => {
      api.calls.push("addIssueLabel");
      added.push(label);
      return {};
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    const { scheduleAutomergeForNewPr } = await import("../src/automerge.ts");
    const result = await scheduleAutomergeForNewPr({
      ...labelInput(api, { issueNumber: 12 }),
      baseBranch: "main",
    } as never);
    expect(added).toEqual(["automerge"]);
    expect(result).toEqual({ scheduled: true });
    expect(api.calls).toContain("scheduleAutoMerge");
  });

  test("no_automerge with automerge:true does not schedule", async () => {
    const api = automergeApi();
    withPrLabels(api, ["no-automerge"]);
    const result = await scheduleAutomergeForPr(labelInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("both labels do not schedule with a conflict note", async () => {
    const api = automergeApi();
    withPrLabels(api, ["automerge", "no-automerge"]);
    withTimeline(api, [{ label: "automerge", actor: "alice", event: "labeled" }]);
    const result = await scheduleAutomergeForPr(labelInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("both");
  });

  test("automerge by an untrusted sender does not schedule with a note", async () => {
    const api = automergeApi();
    withPrLabels(api, ["automerge"]);
    withTimeline(api, [{ label: "automerge", actor: "mallory", event: "labeled" }]);
    api.getCollaboratorPermission = async () => ({ permission: "read" });
    const result = await scheduleAutomergeForPr(labelInput(api, { trustedSenderLogins: ["alice"] }));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("may not turn auto-merge on");
  });

  test("unreadable labeller fails closed with a note", async () => {
    const api = automergeApi();
    withPrLabels(api, ["automerge"]);
    // No listIssueTimeline: history unreadable.
    const result = await scheduleAutomergeForPr(labelInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("could not be read");
  });

  test("adding the label schedules; removing it cancels", async () => {
    const { handleAutomergeLabelChange } = await import("../src/automerge.ts");
    const api = automergeApi();
    withPrLabels(api, [{ name: "automerge" }]);
    withTimeline(api, [{ label: "automerge", actor: "alice", event: "labeled" }]);
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    const scheduled = await handleAutomergeLabelChange({
      ...labelInput(api, { baseBranch: "main" }),
      forgeKind: "gitea",
    } as never);
    expect(scheduled.action).toBe("scheduled");
    expect(api.calls).toContain("scheduleAutoMerge");

    const api2 = automergeApi();
    api2.getRepoFile = async () => {
      api2.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    api2.getPR = async (_o: string, _r: string, index: number) => {
      api2.calls.push("getPR");
      return makePR({ number: index, labels: [] as never });
    };
    api2.cancelAutoMerge = async () => {
      api2.calls.push("cancelAutoMerge");
      return true;
    };
    const cancelled = await handleAutomergeLabelChange({
      ...labelInput(api2, { baseBranch: "main" }),
      forgeKind: "gitea",
    } as never);
    expect(cancelled.action).toBe("cancelled");
    expect(api2.calls).toContain("cancelAutoMerge");
  });

  test("a gate refusal still wins with the label present", async () => {
    const api = automergeApi();
    withPrLabels(api, ["automerge"]);
    withTimeline(api, [{ label: "automerge", actor: "alice", event: "labeled" }]);
    api.getBranch = async () => {
      api.calls.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: ["ci/build"] };
    };
    const result = await scheduleAutomergeForPr(labelInput(api));
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(JUMI_REVIEW_CONTEXT);
  });

  test("custom label names from .jumi.yml decide", async () => {
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\nautomerge_label: ship-it\nno_automerge_label: hold\n" };
    };
    withPrLabels(api, ["SHIP-IT"]);
    withTimeline(api, [{ label: "ship-it", actor: "alice", event: "labeled" }]);
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    const result = await scheduleAutomergeForPr(labelInput(api));
    expect(result).toEqual({ scheduled: true });

    const api2 = automergeApi();
    api2.getRepoFile = async () => {
      api2.calls.push("getRepoFile");
      return { found: true, content: "automerge: true\nautomerge_label: ship-it\nno_automerge_label: hold\n" };
    };
    api2.getPR = async (_o: string, _r: string, index: number) => {
      api2.calls.push("getPR");
      return makePR({ number: index, labels: ["hold"] as never });
    };
    const held = await scheduleAutomergeForPr(labelInput(api2));
    expect(held).toEqual({ scheduled: false });
    expect(api2.calls).not.toContain("scheduleAutoMerge");
  });
});

describe("router mailbox automerge label path", () => {
  function jumiPr(api: ReturnType<typeof automergeApi>, labels: Array<string | { name?: string }>, index = 3) {
    api.getPR = async (_o: string, _r: string, n: number) => {
      api.calls.push("getPR");
      return makePR({
        number: n || index,
        user: makeUser({ login: "jumi" }),
        head: makeBranch({ ref: "jumi/issue-12-foo", sha: "headsha" }),
        title: "Jumi: fix the thing",
        body: "Fixes #12",
        labels: labels as never,
      });
    };
  }

  function labelWebhookBody(action: string, label: string, sender = "alice", prNumber = 3) {
    return new TextEncoder().encode(
      JSON.stringify({
        action,
        repository: {
          full_name: "kirmanak/demo",
          default_branch: "main",
          html_url: "https://gitea.example.test/kirmanak/demo",
          clone_url: "https://gitea.example.test/kirmanak/demo.git",
        },
        label: { name: label },
        sender: { login: sender },
        pull_request: { number: prNumber },
      })
    );
  }

  function webhookPolicy(overrides: Record<string, unknown> = {}) {
    return {
      giteaUrl: "https://gitea.example.test",
      allowedOrgs: ["kirmanak"],
      allowedRepos: [] as string[],
      botUsername: "jumi",
      forgeKind: "gitea",
      ...overrides,
    };
  }

  test("mailbox forwards the five label-path forge methods", async () => {
    const { workerMailboxApi } = await import("../src/server.ts");
    const api = automergeApi();
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [];
    };
    const mailbox = workerMailboxApi(api as never);
    expect(typeof mailbox?.getBranch).toBe("function");
    expect(typeof mailbox?.scheduleAutoMerge).toBe("function");
    expect(typeof mailbox?.cancelAutoMerge).toBe("function");
    expect(typeof mailbox?.getPRFiles).toBe("function");
    expect(typeof mailbox?.listIssueTimeline).toBe("function");
    await mailbox?.getBranch?.("o", "r", "main");
    await mailbox?.getPRFiles?.("o", "r", 3);
    await mailbox?.listIssueTimeline?.("o", "r", 3);
    expect(api.calls).toContain("getBranch");
    expect(api.calls).toContain("getPRFiles");
    expect(api.calls).toContain("listIssueTimeline");

    const bare = automergeApi();
    delete (bare as unknown as Record<string, unknown>)["getBranch"];
    delete (bare as unknown as Record<string, unknown>)["scheduleAutoMerge"];
    delete (bare as unknown as Record<string, unknown>)["cancelAutoMerge"];
    delete (bare as unknown as Record<string, unknown>)["getPRFiles"];
    const bareMailbox = workerMailboxApi(bare as never);
    expect(bareMailbox?.getBranch).toBeUndefined();
    expect(bareMailbox?.scheduleAutoMerge).toBeUndefined();
    expect(bareMailbox?.cancelAutoMerge).toBeUndefined();
    expect(bareMailbox?.getPRFiles).toBeUndefined();
    expect(bareMailbox?.listIssueTimeline).toBeUndefined();
  });

  test("label add through the mailbox schedules even with automerge:false", async () => {
    const { workerMailboxApi } = await import("../src/server.ts");
    const { tryHandleAutomergeLabelEvent } = await import("../src/automerge_webhook.ts");
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    jumiPr(api, ["automerge"]);
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    };
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
    };
    const mailbox = workerMailboxApi(api as never);
    const handled = await tryHandleAutomergeLabelEvent({
      rawBody: labelWebhookBody("labeled", "automerge"),
      policy: webhookPolicy(),
      api: mailbox as never,
      log: () => undefined,
    });
    expect(handled).toEqual({ handled: true, reason: expect.stringContaining("scheduled") });
    expect(api.calls).toContain("scheduleAutoMerge");
  });

  test("label remove through the mailbox cancels", async () => {
    const { workerMailboxApi } = await import("../src/server.ts");
    const { handleAutomergeLabelChange } = await import("../src/automerge.ts");
    const api = automergeApi();
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    };
    jumiPr(api, []);
    api.cancelAutoMerge = async () => {
      api.calls.push("cancelAutoMerge");
      return true;
    };
    const mailbox = workerMailboxApi(api as never);
    const result = await handleAutomergeLabelChange({
      api: mailbox as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: undefined,
      botUsername: "jumi",
      log: () => undefined,
    } as never);
    expect(result.action).toBe("cancelled");
    expect(api.calls).toContain("cancelAutoMerge");
  });

  test("disabled switch posts the disabled note through the mailbox instead of falling through", async () => {
    const { workerMailboxApi } = await import("../src/server.ts");
    const { handleAutomergeLabelChange } = await import("../src/automerge.ts");
    const { tryHandleAutomergeLabelEvent } = await import("../src/automerge_webhook.ts");
    const api = automergeApi();
    jumiPr(api, ["automerge"]);
    const mailbox = workerMailboxApi(api as never);
    const result = await handleAutomergeLabelChange({
      api: mailbox as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: undefined,
      automergeEnabled: false,
      botUsername: "jumi",
      log: () => undefined,
    } as never);
    expect(result.action).toBe("cancelled");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("turned off");

    const api2 = automergeApi();
    jumiPr(api2, ["automerge"]);
    const mailbox2 = workerMailboxApi(api2 as never);
    const handled = await tryHandleAutomergeLabelEvent({
      rawBody: labelWebhookBody("labeled", "automerge"),
      policy: webhookPolicy({ automergeEnabled: false }),
      api: mailbox2 as never,
      log: () => undefined,
    });
    expect(handled.handled).toBe(true);
    expect(api2.notes).toHaveLength(1);
    expect(api2.notes[0]).toContain("turned off");
  });
});

describe("suggestion hold does not change scheduling", () => {
  test("suggestions_hold_merge: false still schedules", async () => {
    const api = automergeApi({
      getRepoFile: async () => ({ found: true, content: "automerge: true\nsuggestions_hold_merge: false\n" }),
    });
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({});
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
    expect(api.scheduled).toHaveLength(1);
  });
});

describe("gitea refused schedule retry after push", () => {
  function refusedBody(detail = "405: Please try again later"): string {
    return (
      `Jumi tried to schedule auto-merge on this pull request but the forge refused (${detail}). ` +
      `Jumi will try again after its next push to the branch; otherwise a person needs to merge once reviews and CI are green.\n` +
      AUTOMERGE_REFUSED_MARKER
    );
  }

  function withRefusedSticky(api: ReturnType<typeof automergeApi>, body: string) {
    (api as unknown as Record<string, unknown>)["listIssueComments"] = async () => {
      api.calls.push("listIssueComments");
      return [{ id: 1, body: `${AUTOMERGE_NOTE_MARKER}\n${body}`, user: { login: "jumi" } }];
    };
  }

  function withNoSticky(api: ReturnType<typeof automergeApi>) {
    (api as unknown as Record<string, unknown>)["listIssueComments"] = async () => {
      api.calls.push("listIssueComments");
      return [];
    };
  }

  test("refused at open, then conflict push schedules and clears the note", async () => {
    const openApi = automergeApi();
    openApi.scheduleAutoMerge = async () => {
      openApi.calls.push("scheduleAutoMerge");
      throw new Error(
        'Gitea API POST https://gitea.example.test/api/v1/repos/kirmanak/demo/pulls/3/merge → 405: {"message":"Please try again later"}'
      );
    };
    const openResult = await scheduleAutomergeForPr({
      api: openApi,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      baseBranch: "main",
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(openResult).toEqual({ scheduled: false });
    expect(openApi.notes).toHaveLength(1);
    expect(openApi.notes[0]).toContain(AUTOMERGE_REFUSED_MARKER);
    expect(openApi.notes[0]).toContain("405: Please try again later");
    expect(openApi.notes[0]).not.toContain("https://");

    const pushApi = automergeApi();
    withRefusedSticky(pushApi, refusedBody());
    pushApi.scheduleAutoMerge = async () => {
      pushApi.calls.push("scheduleAutoMerge");
      pushApi.scheduled.push({});
    };
    await ensureAutomergeAfterPush({
      api: pushApi,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(pushApi.calls.filter((call) => call === "scheduleAutoMerge")).toHaveLength(1);
    expect(pushApi.notes).toHaveLength(1);
    expect(pushApi.notes[0]).toContain("Auto-merge is now scheduled");
  });

  test("refused twice keeps the refused marker with the new reason", async () => {
    const pushApi = automergeApi();
    withRefusedSticky(pushApi, refusedBody("405: Please try again later"));
    pushApi.scheduleAutoMerge = async () => {
      pushApi.calls.push("scheduleAutoMerge");
      throw new Error(
        'Gitea API POST https://gitea.example.test/api/v1/repos/kirmanak/demo/pulls/3/merge → 405: {"message":"Please try again later"}'
      );
    };
    await ensureAutomergeAfterPush({
      api: pushApi,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(pushApi.calls.filter((call) => call === "scheduleAutoMerge")).toHaveLength(1);
    expect(pushApi.notes).toHaveLength(1);
    expect(pushApi.notes[0]).toContain(AUTOMERGE_REFUSED_MARKER);
    expect(pushApi.notes[0]).toContain("405: Please try again later");
  });

  test("no refused note means no schedule call", async () => {
    const api = automergeApi();
    withNoSticky(api);
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toEqual([]);

    const otherApi = automergeApi();
    (otherApi as unknown as Record<string, unknown>)["listIssueComments"] = async () => {
      otherApi.calls.push("listIssueComments");
      return [
        {
          id: 2,
          body: `${AUTOMERGE_NOTE_MARKER}\nJumi did not schedule auto-merge: the labeller could not be read.`,
          user: { login: "jumi" },
        },
      ];
    };
    otherApi.getPR = async (_o: string, _r: string, index: number) => {
      otherApi.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    await ensureAutomergeAfterPush({
      api: otherApi,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(otherApi.calls).not.toContain("scheduleAutoMerge");
    expect(otherApi.notes).toEqual([]);
  });

  test("refused note plus no_automerge label runs the cancel path without scheduling", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge", "no-automerge"] as never });
    };
    api.cancelAutoMerge = async () => {
      api.calls.push("cancelAutoMerge");
      return true;
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).toContain("cancelAutoMerge");
  });

  test("refused note plus untrusted labeller posts the untrusted note without scheduling", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "mallory" } }];
    };
    api.getCollaboratorPermission = async () => ({ permission: "read" });
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      trustedSenderLogins: ["alice"],
      issueNumber: 12,
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("may not turn auto-merge on");
    expect(api.notes[0]).not.toContain(AUTOMERGE_REFUSED_MARKER);
  });

  test("refused markers without the bot author never trigger a schedule", async () => {
    for (const comments of [
      [{ id: 1, body: `${AUTOMERGE_NOTE_MARKER}\n${refusedBody()}` }],
      [{ id: 1, body: `${AUTOMERGE_NOTE_MARKER}\n${refusedBody()}`, user: { login: "someone-else" } }],
    ]) {
      const api = automergeApi();
      (api as unknown as Record<string, unknown>)["listIssueComments"] = async () => {
        api.calls.push("listIssueComments");
        return comments;
      };
      api.getPR = async (_o: string, _r: string, index: number) => {
        api.calls.push("getPR");
        return makePR({ number: index, labels: ["automerge"] as never });
      };
      await ensureAutomergeAfterPush({
        api,
        forgeKind: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 3,
        wasScheduled: false,
        automergeRepos: ["kirmanak/demo"],
        botUsername: "jumi",
        log: () => undefined,
      });
      expect(api.calls).not.toContain("scheduleAutoMerge");
      expect(api.notes).toEqual([]);
    }
  });

  test("missing file, refused note, trusted automerge label via issue schedules and clears the note", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async (
      _o: string,
      _r: string,
      index: number
    ) => {
      api.calls.push("listIssueTimeline");
      if (index === 12) return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
      return [{ event: "labeled", label: "automerge", actor: { login: "jumi" } }];
    };
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
      api.scheduled.push({});
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      issueNumber: 12,
      log: () => undefined,
    });
    expect(api.calls.filter((call) => call === "scheduleAutoMerge")).toHaveLength(1);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("Auto-merge is now scheduled");
  });

  test("missing file, refused note, no automerge label schedules nothing", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: [] as never });
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      issueNumber: 12,
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
  });

  test("missing file, refused note, no-automerge label runs the cancel path without scheduling", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["no-automerge"] as never });
    };
    api.cancelAutoMerge = async () => {
      api.calls.push("cancelAutoMerge");
      return true;
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.calls).toContain("cancelAutoMerge");
  });

  test("missing file, no refused sticky, automerge label schedules nothing", async () => {
    const api = automergeApi();
    withNoSticky(api);
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: false };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    (api as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
      api.calls.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      issueNumber: 12,
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
    expect(api.notes).toEqual([]);
  });

  test("invalid file, refused note schedules nothing without throwing", async () => {
    const api = automergeApi();
    withRefusedSticky(api, refusedBody());
    api.getRepoFile = async () => {
      api.calls.push("getRepoFile");
      return { found: true, content: "automerge: yes-please\n" };
    };
    api.getPR = async (_o: string, _r: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    };
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      wasScheduled: false,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(api.calls).not.toContain("scheduleAutoMerge");
  });
});
