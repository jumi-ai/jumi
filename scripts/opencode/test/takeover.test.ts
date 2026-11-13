import { describe, expect, test } from "bun:test";
import {
  isIgnoreConflictsAuthor,
  isLeftToAuthor,
  leaveConflictsAuthorReason,
  loadIgnoreConflictsAuthors,
} from "../src/ignore_conflicts.ts";
import { shouldEnqueuePushConflicts } from "../src/push_webhook.ts";
import {
  isTakeoverAuthor,
  isTakeoverEligiblePull,
  loadTakeoverAuthors,
  maybeTakeoverPr,
  shouldEnqueueTakeoverForOpenedPull,
  TAKEOVER_NOTE_MARKER,
} from "../src/takeover.ts";
import { makePR, makeRepo, makeUser } from "./fixtures.ts";

function giteaPr(authorLogin: string, overrides: Record<string, unknown> = {}) {
  const repo = makeRepo();
  return makePR({
    number: 42,
    title: "chore(deps): update all",
    body: "",
    state: "open",
    user: makeUser({ login: authorLogin }),
    head: {
      label: "kirmanak:renovate/all",
      ref: "renovate/all",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
    ...overrides,
  });
}

describe("isTakeoverAuthor", () => {
  test("matches whole logins case-insensitive", () => {
    expect(isTakeoverAuthor("Renovate", ["renovate"])).toBe(true);
    expect(isTakeoverAuthor("renovate[bot]", ["Renovate[Bot]"])).toBe(true);
    expect(isTakeoverAuthor("renovate-bot", ["renovate"])).toBe(false);
    expect(isTakeoverAuthor("", ["renovate"])).toBe(false);
    expect(isTakeoverAuthor("renovate", [])).toBe(false);
  });
});

describe("isTakeoverEligiblePull", () => {
  test("open same-repo non-draft is eligible", () => {
    expect(isTakeoverEligiblePull(giteaPr("renovate"), "kirmanak", "demo")).toBe(true);
  });

  test("draft, WIP, closed, merged, and forks are not eligible", () => {
    expect(isTakeoverEligiblePull(giteaPr("renovate", { draft: true }), "kirmanak", "demo")).toBe(false);
    expect(isTakeoverEligiblePull(giteaPr("renovate", { title: "WIP: deps" }), "kirmanak", "demo")).toBe(false);
    expect(isTakeoverEligiblePull(giteaPr("renovate", { state: "closed" }), "kirmanak", "demo")).toBe(false);
    expect(isTakeoverEligiblePull(giteaPr("renovate", { merged: true }), "kirmanak", "demo")).toBe(false);
    const forkRepo = makeRepo({ full_name: "other/demo" });
    expect(
      isTakeoverEligiblePull(
        giteaPr("renovate", {
          head: { label: "other:branch", ref: "branch", sha: "s", repo: forkRepo, repo_id: forkRepo.id },
        }),
        "kirmanak",
        "demo"
      )
    ).toBe(false);
  });
});

describe("loadTakeoverAuthors", () => {
  test("missing file means no takeover", async () => {
    expect(await loadTakeoverAuthors({ getRepoFile: async () => ({ found: false }) }, "o", "r", "main")).toEqual([]);
  });

  test("invalid file means no takeover", async () => {
    expect(
      await loadTakeoverAuthors({ getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) }, "o", "r", "main")
    ).toEqual([]);
  });

  test("valid file loads the list", async () => {
    expect(
      await loadTakeoverAuthors(
        { getRepoFile: async () => ({ found: true, content: "takeover_authors: [Renovate]\n" }) },
        "o",
        "r",
        "main"
      )
    ).toEqual(["Renovate"]);
  });
});

describe("maybeTakeoverPr", () => {
  test("listed admitted author gets the Gitea marker", async () => {
    const assigned: string[][] = [];
    const outcome = await maybeTakeoverPr({
      api: {
        getRepoFile: async () => ({ found: true, content: "takeover_authors: [renovate]\n" }),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        addIssueAssignees: async (_o: string, _r: string, _i: number, assignees: string[]) => {
          assigned.push(assignees);
          return undefined;
        },
      },
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 42,
      prAuthorLogin: "Renovate",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: [],
    });
    expect(outcome).toEqual({ takeover: true, refused: false });
    expect(assigned).toEqual([["jumi"]]);
  });

  test("listed admitted author gets the GitHub marker", async () => {
    const labeled: Array<{ index: number; label: string }> = [];
    const outcome = await maybeTakeoverPr({
      api: {
        getRepoFile: async () => ({ found: true, content: 'takeover_authors: ["renovate[bot]"]\n' }),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        addIssueLabel: async (_o: string, _r: string, index: number, label: string) => {
          labeled.push({ index, label });
          return undefined;
        },
      },
      forgeKind: "github",
      owner: "o",
      repo: "r",
      prNumber: 7,
      prAuthorLogin: "renovate[bot]",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: [],
    });
    expect(outcome).toEqual({ takeover: true, refused: false });
    expect(labeled).toEqual([{ index: 7, label: "jumi" }]);
  });

  test("unlisted author is ignored with no marker and no note", async () => {
    let markers = 0;
    let notes = 0;
    const outcome = await maybeTakeoverPr({
      api: {
        getRepoFile: async () => ({ found: true, content: "takeover_authors: [renovate]\n" }),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        addIssueAssignees: async () => {
          markers++;
          return undefined;
        },
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => {
          notes++;
          return undefined;
        },
        updateIssueComment: async () => {
          notes++;
          return undefined;
        },
      },
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 42,
      prAuthorLogin: "alice",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: [],
    });
    expect(outcome).toEqual({ takeover: false, refused: false });
    expect(markers).toBe(0);
    expect(notes).toBe(0);
  });

  test("listed author failing the sender check gets one note and no marker", async () => {
    let markers = 0;
    const bodies: string[] = [];
    const api = {
      getRepoFile: async () => ({ found: true, content: "takeover_authors: [renovate]\n" }),
      getCollaboratorPermission: async () => ({ permission: "read" }),
      addIssueAssignees: async () => {
        markers++;
        return undefined;
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
        bodies.push(body);
        return { id: 1 };
      },
      updateIssueComment: async () => ({ id: 1 }),
    };
    const input = {
      api,
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 42,
      prAuthorLogin: "renovate",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: ["alice"],
    };
    expect(await maybeTakeoverPr(input)).toEqual({ takeover: false, refused: true });
    expect(await maybeTakeoverPr(input)).toEqual({ takeover: false, refused: true });
    expect(markers).toBe(0);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain("did not take over");
      expect(body).toContain(TAKEOVER_NOTE_MARKER);
    }
  });
});

describe("shouldEnqueueTakeoverForOpenedPull", () => {
  function baseInput(overrides: Record<string, unknown> = {}) {
    const repo = makeRepo();
    return {
      api: {
        getRepoFile: async () => ({ found: true, content: "takeover_authors: [renovate]\n" }),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        addIssueAssignees: async () => undefined,
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => ({ id: 1 }),
        updateIssueComment: async () => ({ id: 1 }),
      } as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 42,
      prTitle: "chore(deps)",
      prDraft: false,
      prState: "open",
      prMerged: false,
      prAuthorLogin: "renovate",
      prHeadRef: "renovate/all",
      prHeadSha: "headsha",
      prHeadRepoFullName: repo.full_name,
      defaultBranch: "main",
      cloneUrl: repo.clone_url,
      htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/42",
      updatedAt: "2026-05-23T00:00:00Z",
      prBody: "",
      botUsername: "jumi",
      trustedSenderLogins: [] as string[],
      ...overrides,
    };
  }

  test("opened enqueues a follow-up job with the takeover trigger", async () => {
    const decision = await shouldEnqueueTakeoverForOpenedPull({ ...baseInput(), action: "opened" });
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.job.mode).toBe("follow-up");
    expect(decision.job.prNumber).toBe(42);
    expect(decision.job.trigger).toEqual({ event: "takeover", sender: "renovate" });
  });

  test("only opened takes over", async () => {
    for (const action of ["synchronize", "reopened", "labeled"]) {
      const decision = await shouldEnqueueTakeoverForOpenedPull({ ...baseInput(), action });
      expect(decision).toEqual({ type: "skip", reason: `unsupported action ${action}` });
    }
  });

  test("forks never take over", async () => {
    const decision = await shouldEnqueueTakeoverForOpenedPull({
      ...baseInput({ prHeadRepoFullName: "other/demo" }),
      action: "opened",
    });
    expect(decision).toEqual({ type: "skip", reason: "not eligible for takeover" });
  });
});

describe("ignore-conflicts authors", () => {
  test("matches whole logins case-insensitive", () => {
    expect(isIgnoreConflictsAuthor("Renovate[Bot]", ["renovate[bot]"])).toBe(true);
    expect(isIgnoreConflictsAuthor("renovate", ["renovate[bot]"])).toBe(false);
    expect(isIgnoreConflictsAuthor("", ["renovate"])).toBe(false);
  });

  test("invalid file leaves to nobody", async () => {
    expect(
      await loadIgnoreConflictsAuthors(
        { getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) },
        "o",
        "r",
        "main"
      )
    ).toEqual([]);
  });

  test("listed author without a Jumi commit is left to the author", async () => {
    const pr = giteaPr("renovate", { mergeable: false, labels: [] });
    const left = await isLeftToAuthor({ listPullCommits: async () => [] }, "kirmanak", "demo", pr, {
      botUsername: "jumi",
      ignoreConflictsAuthors: ["RENOVATE"],
      prAuthor: "renovate",
    });
    expect(left).toBe(true);
    expect(leaveConflictsAuthorReason("renovate")).toContain("conflicted, left to author");
  });

  test("push conflicts skip a listed author with no Jumi commit and no label", async () => {
    const repo = makeRepo();
    const pr = makePR({
      number: 50,
      title: "chore(deps)",
      body: "",
      user: makeUser({ login: "renovate" }),
      assignee: makeUser({ login: "jumi" }),
      assignees: [makeUser({ login: "jumi" })],
      labels: [],
      mergeable: false,
      head: { label: "kirmanak:renovate/all", ref: "renovate/all", sha: "headsha", repo, repo_id: repo.id },
    });
    const decision = await shouldEnqueuePushConflicts(
      {
        ref: "refs/heads/main",
        after: "abc123",
        repository: repo,
        pusher: makeUser({ login: "renovate" }),
        sender: makeUser({ login: "renovate" }),
      } as never,
      { giteaUrl: repo.html_url, allowedOrgs: ["kirmanak"], allowedRepos: [], botUsername: "jumi" },
      {
        listOpenPulls: async () => [pr],
        getIssue: async () => {
          throw new Error("not used");
        },
        listPullCommits: async () => [],
        getRepoFile: async () => ({ found: true, content: "ignore_conflicts_authors: [renovate]\n" }),
      }
    );
    expect(decision.type).toBe("skip");
    if (decision.type !== "skip") return;
    expect(decision.reason).toContain("conflicted, left to author");
    expect(decision.reason).toContain("renovate");
  });
});
