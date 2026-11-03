import { describe, expect, test } from "bun:test";
import {
  extractClosingIssueNumber,
  extractClosingIssueNumbers,
  extractWorkingIssueNumber,
  findOpenClosingPullRequest,
  findOpenJumiClosingPullRequest,
  isAssignedForeignPR,
  isEligibleWorkerPR,
  isForeignPrIdentity,
  isInScopeJumiPR,
  pullRequestClosesIssue,
  refsIssuePattern,
  resolveWorkerPullRequest,
} from "../src/gitea_issues.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import { makePR, makeRepo, makeUser } from "./fixtures.ts";

describe("pullRequestClosesIssue", () => {
  test("matches Gitea default close keywords and optional colon", () => {
    const cases = [
      "Fixes #12",
      "fix #12",
      "Fixed: #12",
      "Closes #12",
      "close #12",
      "closed #12",
      "Resolves #12",
      "resolved: #12",
      "Please resolve #12 thanks",
    ];
    for (const body of cases) {
      expect(pullRequestClosesIssue({ title: "x", body }, 12), body).toBe(true);
    }
    expect(pullRequestClosesIssue({ title: "Fixes #12", body: "" }, 12)).toBe(true);
  });

  test("does not match other issues or non-keywords", () => {
    expect(pullRequestClosesIssue({ title: "x", body: "Fixes #13" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "unfixed #12" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "see issue 12" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "Fixes #12", state: "closed" }, 12)).toBe(false);
  });
});

describe("extractClosingIssueNumber", () => {
  test("prefers close-keywords and skips when branch number differs", () => {
    expect(extractClosingIssueNumber({ title: "x", body: "Fixes #12" })).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "x",
        body: "Fixes #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "x",
        body: "Fixes #12",
        head: { ref: "jumi/issue-13-other" },
      })
    ).toBeUndefined();
    expect(
      extractClosingIssueNumber({
        title: "Fix #11 leftover",
        body: "Fixes #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "Fix #11 leftover",
        body: "see #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBeUndefined();
  });
});

describe("extractClosingIssueNumbers", () => {
  test("unique first-seen from title and body with optional colon", () => {
    expect(
      extractClosingIssueNumbers({
        title: "Fixes #12 and also Fixes #12",
        body: "Fixed: #13\nCloses #12",
      })
    ).toEqual([12, 13]);
  });

  test("appends jumi issue branch when not already listed", () => {
    expect(
      extractClosingIssueNumbers({
        title: "x",
        body: "Fixes #12",
        head: { ref: "jumi/issue-13-other" },
      })
    ).toEqual([12, 13]);
    expect(
      extractClosingIssueNumbers({
        title: "x",
        body: "Fixes #12\nFixes #13",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toEqual([12, 13]);
  });

  test("excludes the PR number itself", () => {
    expect(
      extractClosingIssueNumbers({
        number: 127,
        title: "Fixes #127",
        body: "",
      })
    ).toEqual([]);
  });

  test("ignores see #n mentions without close keywords", () => {
    expect(
      extractClosingIssueNumbers({
        title: "x",
        body: "see #12",
      })
    ).toEqual([]);
  });
});

describe("findOpenClosingPullRequest", () => {
  test("botUsername keeps human Fixes PRs from counting as jumi's", async () => {
    const repo = makeRepo();
    const human = makePR({
      user: makeUser({ login: "alice" }),
      body: "Fixes #12",
      head: { label: "kirmanak:feature", ref: "feature", sha: "abc", repo, repo_id: repo.id },
    });
    const jumi = makePR({
      number: 8,
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "def",
        repo,
        repo_id: repo.id,
      },
    });
    const api = { listOpenPulls: async () => [human, jumi] };
    expect((await findOpenClosingPullRequest(api, "kirmanak", "demo", 12))?.user.login).toBe("alice");
    expect((await findOpenClosingPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
  });
});

describe("findOpenJumiClosingPullRequest", () => {
  test("binds to the extracted jumi branch issue when the body mentions two closes", async () => {
    const repo = makeRepo();
    const pr = makePR({
      number: 8,
      title: "Fixes #12 and leftover Fixes #13",
      body: "Fixes #12\nFixes #13",
      user: makeUser({ login: "jumi" }),
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "def",
        repo,
        repo_id: repo.id,
      },
    });
    const api = { listOpenPulls: async () => [pr] };
    expect((await findOpenJumiClosingPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
    expect(await findOpenJumiClosingPullRequest(api, "kirmanak", "demo", 13, "jumi")).toBeUndefined();
  });
});

describe("isEligibleWorkerPR", () => {
  test("rejects draft, WIP, closed, merged, and forks", () => {
    const repo = makeRepo();
    const base = makePR({
      head: { label: "kirmanak:feature", ref: "feature", sha: "abc", repo, repo_id: repo.id },
    });
    expect(isEligibleWorkerPR(base, "kirmanak", "demo")).toBe(true);
    expect(isEligibleWorkerPR({ ...base, draft: true }, "kirmanak", "demo")).toBe(false);
    expect(isEligibleWorkerPR({ ...base, title: "WIP: x" }, "kirmanak", "demo")).toBe(false);
    expect(isEligibleWorkerPR({ ...base, state: "closed" }, "kirmanak", "demo")).toBe(false);
    expect(isEligibleWorkerPR({ ...base, merged: true }, "kirmanak", "demo")).toBe(false);
    expect(
      isEligibleWorkerPR(
        makePR({
          head: {
            label: "alice:feature",
            ref: "feature",
            sha: "abc",
            repo: makeRepo({ full_name: "alice/demo" }),
            repo_id: 99,
          },
        }),
        "kirmanak",
        "demo"
      )
    ).toBe(false);
  });
});

describe("isAssignedForeignPR", () => {
  test("foreign identity ignores open state so a merged assigned PR still counts as the lock", () => {
    const repo = makeRepo();
    const foreign = makePR({
      state: "closed",
      merged: true,
      user: makeUser({ login: "renovate" }),
      assignee: makeUser({ login: "jumi" }),
      assignees: [makeUser({ login: "jumi" })],
      head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
    });
    expect(isAssignedForeignPR(foreign, "kirmanak", "demo", "jumi")).toBe(false);
    expect(isForeignPrIdentity(foreign, "kirmanak", "demo", "jumi")).toBe(true);
  });

  test("matches an assigned non-jumi PR and ignores jumi closers", () => {
    const repo = makeRepo();
    const foreign = makePR({
      user: makeUser({ login: "renovate" }),
      assignee: makeUser({ login: "jumi" }),
      assignees: [makeUser({ login: "jumi" })],
      head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
    });
    expect(isAssignedForeignPR(foreign, "kirmanak", "demo", "jumi")).toBe(true);
    const closer = makePR({
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      assignee: makeUser({ login: "jumi" }),
      assignees: [makeUser({ login: "jumi" })],
      head: {
        label: "kirmanak:jumi/issue-12-x",
        ref: "jumi/issue-12-x",
        sha: "abc",
        repo,
        repo_id: repo.id,
      },
    });
    expect(isAssignedForeignPR(closer, "kirmanak", "demo", "jumi")).toBe(false);
  });

  test("matches a labeled GitHub foreign PR when pickup is the jumi label", () => {
    const repo = makeRepo();
    const foreign = makePR({
      user: makeUser({ login: "renovate[bot]" }),
      assignee: null,
      assignees: [],
      labels: [{ name: "jumi" }],
      head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
    });
    expect(
      isAssignedForeignPR(foreign, "kirmanak", "demo", "kirmanak-jumi[bot]", {
        botUsername: "kirmanak-jumi[bot]",
        isPickedUp: hasJumiLabel,
      })
    ).toBe(true);
    expect(isAssignedForeignPR(foreign, "kirmanak", "demo", "kirmanak-jumi[bot]")).toBe(false);
  });
});

describe("resolveWorkerPullRequest", () => {
  test("prefers the job prNumber even when the author is not jumi", async () => {
    const repo = makeRepo();
    const foreign = makePR({
      number: 50,
      user: makeUser({ login: "renovate" }),
      head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
    });
    const api = { listOpenPulls: async () => [foreign] };
    expect((await resolveWorkerPullRequest(api, "kirmanak", "demo", 50, "jumi", 50))?.number).toBe(50);
  });
});

describe("extractWorkingIssueNumber", () => {
  test("returns the branch issue for Refs, Fixes, or bare jumi branches", () => {
    for (const body of ["Refs #12", "Fixes #12", "no keyword here"]) {
      expect(
        extractWorkingIssueNumber({
          title: "x",
          body,
          head: { ref: "jumi/issue-12-fix-the-thing" },
        })
      ).toBe(12);
    }
  });

  test("stays routed by the branch when the body names a different issue", () => {
    expect(
      extractWorkingIssueNumber({
        title: "x",
        body: "Fixes #13",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
    expect(
      extractWorkingIssueNumber({
        title: "x",
        body: "Refs #13",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
  });

  test("falls back to the closer off a jumi branch", () => {
    expect(extractWorkingIssueNumber({ title: "x", body: "Fixes #12" })).toBe(12);
    expect(extractWorkingIssueNumber({ title: "x", body: "no keyword" })).toBeUndefined();
  });

  test("refsIssuePattern matches Refs #n", () => {
    expect(refsIssuePattern(12).test("Refs #12")).toBe(true);
    expect(refsIssuePattern(12).test("refs #12")).toBe(true);
    expect(refsIssuePattern(12).test("Ref #12")).toBe(true);
    expect(refsIssuePattern(12).test("Fixes #12")).toBe(false);
    expect(refsIssuePattern(12).test("Refs #13")).toBe(false);
  });

  test("a Refs jumi branch PR is in scope and never foreign", () => {
    const repo = makeRepo();
    const pr = makePR({
      user: makeUser({ login: "jumi" }),
      body: "Refs #12",
      head: {
        label: "kirmanak:jumi/issue-12-x",
        ref: "jumi/issue-12-x",
        sha: "abc",
        repo,
        repo_id: repo.id,
      },
    });
    expect(isInScopeJumiPR(pr, "kirmanak", "demo", "jumi")).toBe(true);
    expect(isForeignPrIdentity(pr, "kirmanak", "demo", "jumi")).toBe(false);
  });

  test("resolves a Refs worker PR by branch issue", async () => {
    const repo = makeRepo();
    const pr = makePR({
      number: 8,
      user: makeUser({ login: "jumi" }),
      body: "Refs #12",
      head: {
        label: "kirmanak:jumi/issue-12-x",
        ref: "jumi/issue-12-x",
        sha: "abc",
        repo,
        repo_id: repo.id,
      },
    });
    const api = { listOpenPulls: async () => [pr] };
    expect((await resolveWorkerPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
    expect((await findOpenJumiClosingPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
  });
});
