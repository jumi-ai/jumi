import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCiMarkdown, readCiState } from "../src/ci.ts";
import { attributableToPr, baseForMarkdown, inspectBaseCi, isBaseGreen } from "../src/ci_base.ts";
import { ciStatePath } from "../src/claim.ts";
import { implementFollowUp } from "../src/followup.ts";
import type { Check, CheckState } from "../src/ports.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs, withWorkspace } from "./harness/temp.ts";

function ciApi(overrides: Parameters<typeof makeIssueApi>[0] = {}) {
  return makeIssueApi({ ...overrides });
}

function baseStatuses(sha: string, state: CheckState): Check[] {
  return [{ id: sha === "headsha" ? 1 : 2, context: "checks", state }];
}

describe("inspectBaseCi", () => {
  test("reports same-name conclusions from the base commit", async () => {
    await withWorkspace(async () => {
      const base = await inspectBaseCi({
        api: ciApi({
          listCommitStatuses: async (_owner, _repo, sha) => baseStatuses(String(sha), "success"),
          listActionJobs: async () => [],
        }),
        owner: "kirmanak",
        repo: "demo",
        baseSha: "basesha",
      });
      expect(base?.sha).toBe("basesha");
      expect(base?.lookupFailed).toBeUndefined();
      expect(base?.results).toEqual([{ name: "checks", conclusion: "success" }]);
    });
  });

  test("ignores the jumi review context and returns undefined for a missing sha", async () => {
    await withWorkspace(async () => {
      const base = await inspectBaseCi({
        api: ciApi({
          listCommitStatuses: async () => [
            { id: 1, context: "jumi/opencode-review", state: "success" },
            { id: 2, context: "checks", state: "failure" },
          ],
          listActionJobs: async () => [],
        }),
        owner: "kirmanak",
        repo: "demo",
        baseSha: "basesha",
      });
      expect(base?.results).toEqual([{ name: "checks", conclusion: "failure" }]);
      const missing = await inspectBaseCi({
        api: ciApi(),
        owner: "kirmanak",
        repo: "demo",
        baseSha: "  ",
      });
      expect(missing).toBeUndefined();
    });
  });

  test("a throwing list call degrades to lookupFailed instead of throwing", async () => {
    await withWorkspace(async () => {
      const base = await inspectBaseCi({
        api: ciApi({
          listCommitStatuses: async () => {
            throw new Error("forge down");
          },
          listActionJobs: async () => [],
        }),
        owner: "kirmanak",
        repo: "demo",
        baseSha: "basesha",
      });
      expect(base?.lookupFailed).toBe(true);
      expect(base?.results).toEqual([]);
    });
  });
});

describe("attributableToPr", () => {
  test("green on base means the head failure belongs to the PR", () => {
    const base = { sha: "basesha", results: [{ name: "checks", conclusion: "success" }] };
    expect(attributableToPr([{ name: "checks" }], base)).toEqual(["checks"]);
    expect(isBaseGreen(base.results, "checks")).toBe(true);
  });

  test("red on base keeps the existing pre-existing handling", () => {
    const base = { sha: "basesha", results: [{ name: "checks", conclusion: "failure" }] };
    expect(attributableToPr([{ name: "checks" }], base)).toEqual([]);
    expect(isBaseGreen(base.results, "checks")).toBe(false);
  });

  test("unknown base, lookup failure, or unknown check never attributes", () => {
    const base = { sha: "basesha", results: [{ name: "checks", conclusion: "success" }] };
    expect(attributableToPr([{ name: "checks" }], undefined)).toEqual([]);
    expect(attributableToPr([{ name: "other" }], base)).toEqual([]);
    expect(attributableToPr([{ name: "checks" }], { ...base, lookupFailed: true })).toEqual([]);
  });

  test("workflow/job alias shapes match like the required-context gate", () => {
    const base = { sha: "basesha", results: [{ name: "checks / build (pull_request)", conclusion: "success" }] };
    expect(attributableToPr([{ name: "build" }], base)).toEqual(["build"]);
  });
});

describe("buildCiMarkdown base evidence", () => {
  test("green on base renders per-check evidence and rejects a no-change disposition", () => {
    const md = buildCiMarkdown({
      sha: "headsha",
      checks: [{ name: "checks", state: "failure", description: "", capped: "##[error]boom", logHash: "x" }],
      base: { sha: "basesha", results: [{ name: "checks", conclusion: "success" }] },
    });
    expect(md).toContain("Base SHA: basesha");
    expect(md).toContain("Base (basesha): success");
    expect(md).toContain("a no-change disposition is not acceptable");
    expect(md).not.toContain("Log truncated");
  });

  test("truncated logs tell the worker to reproduce the failing command locally", () => {
    const md = buildCiMarkdown({
      sha: "headsha",
      checks: [
        {
          name: "checks",
          state: "failure",
          description: "",
          capped: "##[error]boom",
          logHash: "x",
          truncated: true,
        },
      ],
    });
    expect(md).toContain("Log truncated: true");
    expect(md).toContain("reproduce the full failing command locally");
  });
});

describe("baseForMarkdown", () => {
  test("passes inspection base fields through and stays undefined without a base", () => {
    expect(baseForMarkdown({ baseSha: "basesha", baseResults: [{ name: "checks", conclusion: "success" }] })).toEqual({
      sha: "basesha",
      results: [{ name: "checks", conclusion: "success" }],
    });
    expect(baseForMarkdown({})).toBeUndefined();
  });
});

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
  });
}

function redHeadApi(baseState: CheckState) {
  const comments: string[] = [];
  const fake = makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [jumiPr()],
    listIssueComments: async () => [],
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listCommitStatuses: async (_owner, _repo, sha) =>
      String(sha) === "headsha"
        ? [{ id: 1, context: "checks", status: "failure" }]
        : [{ id: 2, context: "checks", status: baseState }],
    listActionJobs: async (_owner, _repo, filter) =>
      (filter as { headSha?: string } | undefined)?.headSha === "headsha"
        ? [{ id: 9, name: "checks", head_sha: "headsha", status: "completed", conclusion: "failure" }]
        : [],
    getActionJobLogs: async () =>
      [
        ...Array.from({ length: 2500 }, (_, i) => `setup padding line ${i} xxxxxxxxxxxxxxxxxxxxxxxxxx`),
        "##[error]boom",
        ...Array.from({ length: 2500 }, (_, i) => `teardown padding line ${i} yyyyyyyyyyyyyyyyyyyyyyyyyy`),
      ].join("\n"),
  });
  return Object.assign(fake, { comments });
}

function followUpJob() {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    trigger: { event: "workflow_job", sender: "alice" },
  });
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

describe("red-CI follow-up with a green base", () => {
  test("blocks no-changes, records nothing handled, and stays actionable", async () => {
    await withDirs(async (home, workdir) => {
      const api = redHeadApi("success");
      let ciMarkdown = "";
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          ciMarkdown = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("skipped");
      expect(String((result as { reason?: unknown }).reason)).toMatch(/^stuck: /);
      expect(String((result as { reason?: unknown }).reason)).toContain("attributable to");
      // The worker saw "green on main" directly, including the truncation flag.
      expect(ciMarkdown).toContain("Base (basesha): success");
      expect(ciMarkdown).toContain("no-change disposition is not acceptable");
      expect(ciMarkdown).toContain("reproduce the full failing command locally");
      // Not recorded as handled, so a later wake re-runs the CI follow-up.
      expect((await readCiState(ciStatePath(home, "kirmanak", "demo", 12))).handled).toEqual([]);
      expect(api.comments.some((body) => body.includes("no follow-up changes"))).toBe(false);
    });
  });

  test("red on base keeps the existing no-changes handling", async () => {
    await withDirs(async (home, workdir) => {
      const api = redHeadApi("failure");
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect((await readCiState(ciStatePath(home, "kirmanak", "demo", 12))).handled).toHaveLength(1);
    });
  });
});
