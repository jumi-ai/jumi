import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLabel } from "../src/assignee.ts";
import { sitMessage } from "../src/board.ts";
import { loadConfig } from "../src/config.ts";
import { needsConflict } from "../src/conflict.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "../src/forge.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import {
  hasIgnoreConflictsLabel,
  hasJumiCommit,
  ignoreConflictsReason,
  isIgnoreConflictsSkipReason,
  isLeftToAuthor,
  normalizeIgnoreConflictsLabel,
} from "../src/ignore_conflicts.ts";
import { classifyCloserWork, conflictJobIfUnmergeable } from "../src/pickup.ts";
import { shouldEnqueuePushConflicts } from "../src/push_webhook.ts";
import { normalizeSitReason } from "../src/router_sits.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";
import { emptyCiMethods, makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

const repo = makeRepo();

function renovateCommit() {
  return {
    sha: "abc",
    author: { name: "renovate[bot]", email: "29139614+renovate[bot]@users.noreply.github.com", login: "renovate[bot]" },
    committer: {
      name: "renovate[bot]",
      email: "29139614+renovate[bot]@users.noreply.github.com",
      login: "renovate[bot]",
    },
  };
}

function jumiCommit() {
  return {
    sha: "def",
    author: { name: FORGE_COMMITTER_NAME, email: FORGE_COMMITTER_EMAIL, login: "jumi" },
    committer: { name: FORGE_COMMITTER_NAME, email: FORGE_COMMITTER_EMAIL, login: "jumi" },
  };
}

function labelledForeignPR(forge: "gitea" | "github") {
  if (forge === "github") {
    const githubRepo = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    return makePR({
      number: 55,
      title: "chore(deps)",
      body: "",
      user: makeUser({ login: "renovate[bot]" }),
      labels: [{ name: "ignore-conflicts" }, { name: "jumi" }],
      mergeable: false,
      html_url: "https://github.com/kirmanak/demo/pull/55",
      head: {
        label: "kirmanak:renovate/all-digest",
        ref: "renovate/all-digest",
        sha: "headsha",
        repo: githubRepo,
        repo_id: githubRepo.id,
      },
    });
  }
  return makePR({
    number: 50,
    title: "chore(deps)",
    body: "",
    user: makeUser({ login: "renovate" }),
    assignee: makeUser({ login: "jumi" }),
    assignees: [makeUser({ login: "jumi" })],
    labels: [{ name: "ignore-conflicts" }],
    mergeable: false,
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
    head: {
      label: "kirmanak:renovate/all-digest",
      ref: "renovate/all-digest",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
  });
}

function pushPolicy(forge: "gitea" | "github") {
  if (forge === "github") {
    return {
      giteaUrl: "https://github.com",
      allowedOrgs: ["kirmanak"],
      allowedRepos: [],
      botUsername: "kirmanak-jumi[bot]",
      isPickedUp: (issue: { labels?: unknown[] | null }) =>
        hasLabel(issue as { labels?: Array<string | { name?: string }> | null }, "jumi"),
      ignoreConflictsLabel: "ignore-conflicts",
    };
  }
  return {
    giteaUrl: "https://gitea.kirmanak.stream",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
    ignoreConflictsLabel: "ignore-conflicts",
  };
}

function pushPayload(repository = repo) {
  return {
    ref: `refs/heads/${repository.default_branch}`,
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    repository,
    pusher: makeUser({ login: "alice" }),
    sender: makeUser({ login: "alice" }),
    commits: [],
  };
}

describe("ignore-conflicts label helpers", () => {
  test("normalize defaults to ignore-conflicts", () => {
    expect(normalizeIgnoreConflictsLabel(undefined)).toBe("ignore-conflicts");
    expect(normalizeIgnoreConflictsLabel("")).toBe("ignore-conflicts");
    expect(normalizeIgnoreConflictsLabel("  ")).toBe("ignore-conflicts");
    expect(normalizeIgnoreConflictsLabel("renovate-freeze")).toBe("renovate-freeze");
  });

  test("label match is case-insensitive", () => {
    const pr = makePR({ labels: [{ name: "Ignore-Conflicts" }] });
    expect(hasIgnoreConflictsLabel(pr, "ignore-conflicts")).toBe(true);
    expect(hasIgnoreConflictsLabel(pr, undefined)).toBe(true);
    expect(hasIgnoreConflictsLabel(makePR({ labels: [] }), "ignore-conflicts")).toBe(false);
  });

  test("custom label name is honored", () => {
    const pr = makePR({ labels: [{ name: "freeze" }] });
    expect(hasIgnoreConflictsLabel(pr, "freeze")).toBe(true);
    expect(hasIgnoreConflictsLabel(pr, "ignore-conflicts")).toBe(false);
    expect(ignoreConflictsReason("freeze")).toBe("conflicted, left to author (label `freeze`)");
  });

  test("reason round-trips through sits", () => {
    const reason = ignoreConflictsReason("ignore-conflicts");
    expect(reason).toBe("conflicted, left to author (label `ignore-conflicts`)");
    expect(isIgnoreConflictsSkipReason(reason)).toBe(true);
    expect(normalizeSitReason(reason)).toBe("conflict-ignored");
    expect(sitMessage("conflict-ignored")).toContain("conflicted, left to author");
    expect(sitMessage("conflict-ignored")).not.toContain("ignore-conflicts");
  });

  test("hasJumiCommit matches forge identity, not other bots", () => {
    expect(hasJumiCommit([jumiCommit()], { botUsername: "jumi" })).toBe(true);
    expect(hasJumiCommit([renovateCommit()], { botUsername: "jumi" })).toBe(false);
    expect(hasJumiCommit([], { botUsername: "jumi" })).toBe(false);
    expect(
      hasJumiCommit([{ sha: "x", author: { login: "JUMI" }, committer: { login: "other" } }], { botUsername: "jumi" })
    ).toBe(true);
  });

  test("isLeftToAuthor needs the label and no Jumi commit", async () => {
    const pr = makePR({ number: 50, labels: [{ name: "ignore-conflicts" }] });
    const api = { listPullCommits: async () => [renovateCommit()] };
    expect(await isLeftToAuthor(api, "o", "r", pr, { botUsername: "jumi" })).toBe(true);
    const withJumi = { listPullCommits: async () => [renovateCommit(), jumiCommit()] };
    expect(await isLeftToAuthor(withJumi, "o", "r", pr, { botUsername: "jumi" })).toBe(false);
    expect(await isLeftToAuthor(api, "o", "r", makePR({ number: 50 }), { botUsername: "jumi" })).toBe(false);
  });
});

describe("config", () => {
  test("IGNORE_CONFLICTS_LABEL defaults and customizes", () => {
    const required = {
      GITEA_URL: "https://gitea.kirmanak.stream/",
      GITEA_BOT_TOKEN: "bot-token",
      GITEA_WEBHOOK_SECRET: "secret",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
    };
    expect(loadConfig(required).ignoreConflictsLabel).toBe("ignore-conflicts");
    expect(loadConfig({ ...required, IGNORE_CONFLICTS_LABEL: "freeze" }).ignoreConflictsLabel).toBe("freeze");
    expect(loadWorkerConfig({ ...required, GITEA_WEBHOOK_SECRET: "secret" }).ignoreConflictsLabel).toBe(
      "ignore-conflicts"
    );
  });
});

for (const forge of ["gitea", "github"] as const) {
  describe(`push conflicts (${forge})`, () => {
    test("labelled and untouched: no conflict job", async () => {
      const pr = labelledForeignPR(forge);
      const repository =
        forge === "github"
          ? makeRepo({
              html_url: "https://github.com/kirmanak/demo",
              clone_url: "https://github.com/kirmanak/demo.git",
            })
          : repo;
      const api = {
        listOpenPulls: async () => [pr],
        getIssue: async () => makeIssue(),
        listPullCommits: async () => [renovateCommit()],
      };
      const decision = await shouldEnqueuePushConflicts(pushPayload(repository), pushPolicy(forge), api);
      expect(decision.type).toBe("skip");
      if (decision.type !== "skip") return;
      expect(decision.reason).toContain("conflicted, left to author");
      expect(decision.reason).toContain("ignore-conflicts");
    });

    test("labelled after a Jumi commit: conflict job runs", async () => {
      const pr = labelledForeignPR(forge);
      const repository =
        forge === "github"
          ? makeRepo({
              html_url: "https://github.com/kirmanak/demo",
              clone_url: "https://github.com/kirmanak/demo.git",
            })
          : repo;
      const api = {
        listOpenPulls: async () => [pr],
        getIssue: async () => makeIssue(),
        listPullCommits: async () => [renovateCommit(), jumiCommit()],
      };
      const decision = await shouldEnqueuePushConflicts(pushPayload(repository), pushPolicy(forge), api);
      expect(decision.type).toBe("enqueue");
    });

    test("unlabelled: behavior unchanged", async () => {
      const pr = labelledForeignPR(forge);
      pr.labels = forge === "github" ? [{ name: "jumi" }] : [];
      if (forge === "gitea") {
        pr.assignee = makeUser({ login: "jumi" });
        pr.assignees = [makeUser({ login: "jumi" })];
      }
      const repository =
        forge === "github"
          ? makeRepo({
              html_url: "https://github.com/kirmanak/demo",
              clone_url: "https://github.com/kirmanak/demo.git",
            })
          : repo;
      const api = {
        listOpenPulls: async () => [pr],
        getIssue: async () => makeIssue(),
        listPullCommits: async () => [renovateCommit()],
      };
      const decision = await shouldEnqueuePushConflicts(pushPayload(repository), pushPolicy(forge), api);
      expect(decision.type).toBe("enqueue");
    });
  });

  describe(`conflict gating (${forge})`, () => {
    test("labelled and untouched: needsConflict false, no conflict job", async () => {
      const home = await mkdtemp(join(tmpdir(), "jumi-ignore-"));
      try {
        const pr = labelledForeignPR(forge);
        expect(
          await needsConflict({
            pr,
            owner: "kirmanak",
            repo: "demo",
            issueNumber: 50,
            botUsername: "jumi",
            home,
            hasJumiCommit: false,
            ignoreConflictsLabel: "ignore-conflicts",
          })
        ).toBe(false);
        const job = makeIssueJob({ owner: "kirmanak", repo: "demo", issueNumber: pr.number });
        const api = {
          getPR: async () => pr,
          listPullCommits: async () => [renovateCommit()],
        };
        expect(
          await conflictJobIfUnmergeable(api, job, pr.number, undefined, {
            botUsername: "jumi",
            ignoreConflictsLabel: "ignore-conflicts",
          })
        ).toBeUndefined();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    test("labelled after a Jumi commit: conflict job runs", async () => {
      const home = await mkdtemp(join(tmpdir(), "jumi-ignore-"));
      try {
        const pr = labelledForeignPR(forge);
        expect(
          await needsConflict({
            pr,
            owner: "kirmanak",
            repo: "demo",
            issueNumber: 50,
            botUsername: "jumi",
            home,
            hasJumiCommit: true,
            ignoreConflictsLabel: "ignore-conflicts",
          })
        ).toBe(true);
        const job = makeIssueJob({ owner: "kirmanak", repo: "demo", issueNumber: pr.number });
        const api = {
          getPR: async () => pr,
          listPullCommits: async () => [jumiCommit()],
        };
        const conflictJob = await conflictJobIfUnmergeable(api, job, pr.number, undefined, {
          botUsername: "jumi",
          ignoreConflictsLabel: "ignore-conflicts",
        });
        expect(conflictJob?.mode).toBe("conflict");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    test("labelled and untouched with follow-up wake still classifies follow-up", async () => {
      const home = await mkdtemp(join(tmpdir(), "jumi-ignore-"));
      try {
        const closer = makePR({
          number: 127,
          title: "Fix the thing",
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
          labels: [{ name: "ignore-conflicts" }],
          mergeable: false,
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        });
        const api: IssueApi = {
          getRepo: async () => repo,
          getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
          getIssue: async () => makeIssue(),
          getPR: async (_o, _r, n) => ({ ...closer, number: n }),
          listOpenPulls: async () => [],
          createPullRequest: async (_o, _r, pull) => makePR({ title: pull.title, body: pull.body }),
          closePullRequest: async (_o, _r, n) => makePR({ number: n, state: "closed" }),
          updatePullRequestBody: async (_o, _r, n, body) => makePR({ number: n, body }),
          findStickyIssueComment: async () => undefined,
          createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
          updateIssueComment: async (_o, _r, _id, body) => makeComment({ body }),
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix", user: makeUser({ login: "alice" }) }),
          ],
          listPullReviewComments: async () => [],
          listPullReviews: async () => [],
          listPullCommits: async () => [renovateCommit()],
          ...emptyCiMethods(),
        };
        const mode = await classifyCloserWork({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: { ...closer, mergeable: false },
          issueNumber: 12,
          botUsername: "jumi",
          home,
          ignoreConflictsLabel: "ignore-conflicts",
        });
        expect(mode).toBe("follow-up");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    test("labelled mergeable PR with feedback is left to author for the default-merge", async () => {
      const home = await mkdtemp(join(tmpdir(), "jumi-ignore-"));
      try {
        const closer = makePR({
          number: 127,
          title: "Fix the thing",
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
          labels: [{ name: "ignore-conflicts" }],
          mergeable: true,
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        });
        // The default-merge skip in follow-up must not depend on mergeable:
        // a labelled, still-mergeable (behind default) PR stays left to author.
        expect(
          await isLeftToAuthor({ listPullCommits: async () => [renovateCommit()] }, "o", "r", closer, {
            botUsername: "jumi",
          })
        ).toBe(true);
        const api: IssueApi = {
          getRepo: async () => repo,
          getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
          getIssue: async () => makeIssue(),
          getPR: async (_o, _r, n) => ({ ...closer, number: n }),
          listOpenPulls: async () => [],
          createPullRequest: async (_o, _r, pull) => makePR({ title: pull.title, body: pull.body }),
          closePullRequest: async (_o, _r, n) => makePR({ number: n, state: "closed" }),
          updatePullRequestBody: async (_o, _r, n, body) => makePR({ number: n, body }),
          findStickyIssueComment: async () => undefined,
          createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
          updateIssueComment: async (_o, _r, _id, body) => makeComment({ body }),
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix", user: makeUser({ login: "alice" }) }),
          ],
          listPullReviewComments: async () => [],
          listPullReviews: async () => [],
          listPullCommits: async () => [renovateCommit()],
          ...emptyCiMethods(),
        };
        const mode = await classifyCloserWork({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: { ...closer, mergeable: true },
          issueNumber: 12,
          botUsername: "jumi",
          home,
          ignoreConflictsLabel: "ignore-conflicts",
        });
        expect(mode).toBe("follow-up");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    test("follow-up wake skips the commit lookup", async () => {
      const home = await mkdtemp(join(tmpdir(), "jumi-ignore-"));
      try {
        const closer = makePR({
          number: 127,
          title: "Fix the thing",
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
          labels: [{ name: "ignore-conflicts" }],
          mergeable: false,
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        });
        let commitLookups = 0;
        const api: IssueApi = {
          getRepo: async () => repo,
          getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
          getIssue: async () => makeIssue(),
          getPR: async (_o, _r, n) => ({ ...closer, number: n }),
          listOpenPulls: async () => [],
          createPullRequest: async (_o, _r, pull) => makePR({ title: pull.title, body: pull.body }),
          closePullRequest: async (_o, _r, n) => makePR({ number: n, state: "closed" }),
          updatePullRequestBody: async (_o, _r, n, body) => makePR({ number: n, body }),
          findStickyIssueComment: async () => undefined,
          createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
          updateIssueComment: async (_o, _r, _id, body) => makeComment({ body }),
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix", user: makeUser({ login: "alice" }) }),
          ],
          listPullReviewComments: async () => [],
          listPullReviews: async () => [],
          listPullCommits: async () => {
            commitLookups += 1;
            return [renovateCommit()];
          },
          ...emptyCiMethods(),
        };
        const mode = await classifyCloserWork({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: { ...closer, mergeable: false },
          issueNumber: 12,
          botUsername: "jumi",
          home,
          ignoreConflictsLabel: "ignore-conflicts",
        });
        expect(mode).toBe("follow-up");
        expect(commitLookups).toBe(0);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });
}
