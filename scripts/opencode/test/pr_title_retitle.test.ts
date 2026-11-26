import { describe, expect, test } from "bun:test";
import {
  hasJumiAuthoredCommit,
  implementFollowUp,
  isPrTitleRetitleEligible,
  isRetitleSettingOn,
} from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import {
  extractOriginalTitle,
  formatOriginalTitleMarker,
  PR_BODY_FENCE_END,
  PR_BODY_FENCE_START,
  withOriginalTitleMarker,
} from "../src/implement.ts";
import { buildFollowupPrompt } from "../src/git.ts";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import { probeWorkerMcpServer } from "../src/worker_mcp.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { emptyCiMethods, makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

const fenced = (text: string) => `${PR_BODY_FENCE_START}\n${text}\n${PR_BODY_FENCE_END}`;

function adoptedPr(opts: { title?: string; body?: string } = {}) {
  const repo = makeRepo();
  return makePR({
    number: 7007,
    title: opts.title ?? "Update jumi to v11.3.122",
    body: opts.body ?? `Renovate table.\n\n${fenced("Old writeup.\n\nFixes #12")}`,
    user: makeUser({ login: "renovate[bot]" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7007",
    head: {
      label: "kirmanak:renovate/jumi-11.x",
      ref: "renovate/jumi-11.x",
      sha: "headsha7007",
      repo,
      repo_id: repo.id,
    },
  });
}

function jumiCommit() {
  return {
    sha: "def",
    author: { name: "jumi", email: "jumi@localhost", login: "jumi" },
    committer: { name: "jumi", email: "jumi@localhost", login: "jumi" },
  };
}

function renovateCommit() {
  return {
    sha: "abc",
    author: { name: "renovate[bot]", email: "29139614+renovate[bot]@users.noreply.github.com" },
    committer: { name: "renovate[bot]", email: "29139614+renovate[bot]@users.noreply.github.com" },
  };
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

async function runAdoptedFollowUp(opts: {
  pr?: ReturnType<typeof adoptedPr>;
  commits?: unknown[];
  commitsError?: boolean;
  commitsMissing?: boolean;
  settingsContent?: string | null;
  settingsMissing?: boolean;
  recordTitle?: string | null;
  liveTitleOverride?: string | null;
  titlePatchError?: boolean;
  porcelain?: string;
}) {
  const titlePatches: string[] = [];
  const bodyPatches: string[] = [];
  const logs: string[] = [];
  let result: Awaited<ReturnType<typeof implementFollowUp>> | undefined;
  let probeOk: boolean | undefined;
  const basePr = opts.pr ?? adoptedPr();
  let liveTitle = opts.liveTitleOverride ?? basePr.title;
  // Live body evolves as PATCHes land so marker assertions see the parent's writes.
  let liveBody: string = basePr.body as string;
  await withDirs(async (home, workdir) => {
    const pr = { ...basePr };
    const apiBase: Partial<IssueApi> = {
      getIssue: async () => makeIssue({ number: 7007 }),
      listOpenPulls: async () => [pr],
      getPR: async () => ({ ...pr, title: liveTitle, body: liveBody }),
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please address", user: makeUser({ login: "alice" }) }),
      ],
      updatePullRequestBody: async (_o, _r, _index, body) => {
        bodyPatches.push(body);
        liveBody = body;
        return makePR({ number: pr.number, body });
      },
      ...(opts.titlePatchError
        ? {
            updatePullRequestTitle: async () => {
              throw new Error("forge 500");
            },
          }
        : {
            updatePullRequestTitle: async (_o: string, _r: string, _index: number, title: string) => {
              titlePatches.push(title);
              liveTitle = title;
              return makePR({ number: pr.number, title });
            },
          }),
      ...emptyCiMethods(),
    };
    if (opts.commitsMissing) {
      const { listPullCommits: _drop, ...rest } = apiBase as Record<string, unknown>;
      Object.assign(apiBase, { listPullCommits: undefined });
      void _drop;
      void rest;
    } else if (opts.commitsError) {
      (apiBase as Record<string, unknown>).listPullCommits = async () => {
        throw new Error("forge 500");
      };
    } else {
      (apiBase as Record<string, unknown>).listPullCommits = async () => opts.commits ?? [jumiCommit()];
    }
    if (opts.settingsMissing) {
      (apiBase as Record<string, unknown>).getRepoFile = async () => ({ found: false });
    } else if (opts.settingsContent !== undefined && opts.settingsContent !== null) {
      (apiBase as Record<string, unknown>).getRepoFile = async () => ({
        found: true,
        content: opts.settingsContent as string,
      });
    } else {
      (apiBase as Record<string, unknown>).getRepoFile = async () => ({ found: false });
    }
    const api = makeIssueApi(apiBase as Partial<IssueApi>);
    result = await implementFollowUp({
      api,
      job: makeIssueJob({ mode: "follow-up", issueNumber: 7007, prNumber: 7007 }),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: (async (args: string[]) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return opts.porcelain ?? "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      }) as unknown as GitRunner,
      openCodeRunner: async (runOpts: { workerMcp?: { url: string; token: string } }) => {
        if (opts.recordTitle != null && runOpts.workerMcp) {
          const out = await probeWorkerMcpServer(runOpts.workerMcp.url, runOpts.workerMcp.token, "set_pr_title", {
            title: opts.recordTitle,
            reason: "commits changed scope",
          });
          probeOk = out.ok;
        }
        return { status: "ok" };
      },
      logger: (message: string) => {
        logs.push(message);
      },
    });
  });
  return { result, titlePatches, bodyPatches, logs, liveBody, liveTitle, probeOk };
}

describe("adopted PR retitle", () => {
  test("adopted PR with a Jumi commit and a recorded title sends one title PATCH with marker", async () => {
    const run = await runAdoptedFollowUp({ recordTitle: "Pin Jumi to v11.3.118" });
    expect(run.titlePatches).toEqual(["Pin Jumi to v11.3.118"]);
    expect(run.logs.some((line) => line.includes("pr_title from tool"))).toBe(true);
    const markerBody = run.bodyPatches.find((body) => body.includes("jumi-original-title"));
    expect(markerBody).toBeDefined();
    expect(extractOriginalTitle(markerBody)).toBe("Update jumi to v11.3.122");
  });

  test("no Jumi commit means no title PATCH while the body still refreshes", async () => {
    const run = await runAdoptedFollowUp({
      commits: [renovateCommit()],
      recordTitle: "Pin Jumi to v11.3.118",
    });
    expect(run.titlePatches).toEqual([]);
    // The tool is hidden when the branch has no Jumi commit, so the recording
    // itself fails and the apply step sees nothing to do.
    expect(run.probeOk).toBe(false);
    expect(run.logs.some((line) => line.includes("pr_title"))).toBe(true);
  });

  test("Jumi PR never retitles even when a title is recorded", async () => {
    const repo = makeRepo();
    const jumi = makePR({
      number: 127,
      title: "Fix the thing",
      body: fenced("Old writeup."),
      user: makeUser({ login: "jumi" }),
      head: { label: "kirmanak:jumi/issue-12-x", ref: "jumi/issue-12-x", sha: "headsha", repo, repo_id: repo.id },
    });
    const titlePatches: string[] = [];
    const logs: string[] = [];
    await withDirs(async (home, workdir) => {
      const api = makeIssueApi({
        getIssue: async () => makeIssue(),
        listOpenPulls: async () => [jumi],
        getPR: async () => jumi,
        listIssueComments: async () => [],
        updatePullRequestBody: async (_o, _r, index, body) => makePR({ number: index, body }),
        updatePullRequestTitle: async (_o: string, _r: string, index: number, title: string) => {
          titlePatches.push(title);
          return makePR({ number: index, title });
        },
        listPullCommits: async () => [jumiCommit()],
        getRepoFile: async () => ({ found: false }),
        ...emptyCiMethods(),
      });
      await implementFollowUp({
        api,
        job: makeIssueJob({ mode: "follow-up", prNumber: 127 }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: (async (args: string[]) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        }) as unknown as GitRunner,
        openCodeRunner: async (runOpts: { workerMcp?: { url: string; token: string } }) => {
          if (runOpts.workerMcp) {
            const out = await probeWorkerMcpServer(runOpts.workerMcp.url, runOpts.workerMcp.token, "set_pr_title", {
              title: "Should not apply",
            });
            expect(out.ok).toBe(false);
          }
          return { status: "ok" };
        },
        logger: (message: string) => {
          logs.push(message);
        },
      });
    });
    expect(titlePatches).toEqual([]);
  });

  test("live title changed since job start means no PATCH and a skip log", async () => {
    const run = await runAdoptedFollowUp({
      recordTitle: "Pin Jumi to v11.3.118",
      liveTitleOverride: "Edited by a person",
    });
    expect(run.titlePatches).toEqual([]);
    expect(run.logs.some((line) => line.includes("pr_title skipped (live title changed)"))).toBe(true);
  });

  test("identical title means no PATCH", async () => {
    const run = await runAdoptedFollowUp({
      recordTitle: "Update jumi to v11.3.122",
    });
    expect(run.titlePatches).toEqual([]);
    expect(run.logs.some((line) => line.includes("pr_title skipped (identical)"))).toBe(true);
  });

  test("retitle_adopted_prs false disables the tool and the PATCH", async () => {
    const run = await runAdoptedFollowUp({
      settingsContent: "retitle_adopted_prs: false\n",
      recordTitle: "Pin Jumi to v11.3.118",
    });
    expect(run.titlePatches).toEqual([]);
    expect(run.probeOk).toBe(false);
    expect(run.logs.some((line) => line.includes("pr_title"))).toBe(true);
  });

  test("missing file means on, invalid file means off", async () => {
    const missing = await runAdoptedFollowUp({ settingsMissing: true, recordTitle: "Pin Jumi to v11.3.118" });
    expect(missing.titlePatches).toEqual(["Pin Jumi to v11.3.118"]);
    const invalid = await runAdoptedFollowUp({
      settingsContent: "retitle_adopted_prs: 42\n",
      recordTitle: "Pin Jumi to v11.3.118",
    });
    expect(invalid.titlePatches).toEqual([]);
  });

  test("listPullCommits unavailable or throwing means no retitle", async () => {
    const missing = await runAdoptedFollowUp({ commitsMissing: true, recordTitle: "Pin Jumi to v11.3.118" });
    expect(missing.titlePatches).toEqual([]);
    const throwing = await runAdoptedFollowUp({ commitsError: true, recordTitle: "Pin Jumi to v11.3.118" });
    expect(throwing.titlePatches).toEqual([]);
  });

  test("forge error on the title PATCH is logged and the round still succeeds", async () => {
    const run = await runAdoptedFollowUp({ recordTitle: "Pin Jumi to v11.3.118", titlePatchError: true });
    expect(run.titlePatches).toEqual([]);
    expect(run.logs.some((line) => line.includes("pr_title forge error"))).toBe(true);
    expect(run.result?.status).toBe("no-changes");
  });

  test("second round keeps the first original title", async () => {
    const first = await runAdoptedFollowUp({ recordTitle: "Pin Jumi to v11.3.118" });
    const firstMarker = first.bodyPatches.find((body) => body.includes("jumi-original-title"));
    expect(firstMarker).toBeDefined();
    const original = extractOriginalTitle(firstMarker);
    expect(original).toBe("Update jumi to v11.3.122");
    // A later body rewrite keeps the marker; a second retitle keeps the first original.
    const rewritten = withOriginalTitleMarker("Second disclosure.", original as string);
    expect(extractOriginalTitle(rewritten)).toBe("Update jumi to v11.3.122");
    const secondMarker = withOriginalTitleMarker(`${formatOriginalTitleMarker("Something else")}\nbody`, original as string);
    expect(extractOriginalTitle(secondMarker)).toBe("Something else");
  });
});

describe("original title marker and reviewer prompt", () => {
  test("marker escapes dashes", () => {
    const marker = formatOriginalTitleMarker("a -- b");
    expect(marker).not.toContain(" -- ");
    expect(marker).toContain("jumi-original-title");
    expect(extractOriginalTitle(marker)).toBe("a -- b");
  });

  test("reviewer prompt contains original_title only when the marker is present", async () => {
    const repo = makeRepo();
    const base = {
      number: 7007,
      title: "Pin Jumi to v11.3.118",
      state: "open" as const,
      user: makeUser({ login: "renovate[bot]" }),
      head: { ref: "renovate/jumi-11.x", sha: "headsha", repo: { full_name: "kirmanak/demo" } },
      base: { ref: "main", sha: "basesha" },
      merged: false,
      created_at: "2026-05-23T00:00:00Z",
      updated_at: "2026-05-23T00:00:00Z",
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7007",
    };
    const without = buildPROpenedPrompt({ repo, pr: { ...base, body: "plain" }, prFiles: [] });
    expect(without).not.toContain("<original_title>");
    const withMarker = buildPROpenedPrompt({
      repo,
      pr: { ...base, body: `text\n${formatOriginalTitleMarker("Update jumi to v11.3.122")}` },
      prFiles: [],
      originalTitle: "Update jumi to v11.3.122",
    });
    expect(withMarker).toContain("<original_title>Update jumi to v11.3.122</original_title>");
  });

  test("worker prompt mentions set_pr_title only when eligible", () => {
    expect(buildFollowupPrompt(undefined, { prBodyFenced: true, prTitleEligible: true })).toContain("set_pr_title");
    expect(buildFollowupPrompt(undefined, { prBodyFenced: true, prTitleEligible: false })).not.toContain(
      "set_pr_title"
    );
    expect(buildFollowupPrompt(undefined, { prBodyFenced: true })).not.toContain("set_pr_title");
  });

  test("eligibility helpers fail closed", async () => {
    expect(isRetitleSettingOn({ state: "no-branch" })).toBe(false);
    expect(isRetitleSettingOn({ state: "loaded", load: { state: "missing" } })).toBe(true);
    expect(isRetitleSettingOn({ state: "loaded", load: { state: "invalid", error: "bad" } })).toBe(false);
    expect(
      await hasJumiAuthoredCommit({ listPullCommits: async () => [jumiCommit()] }, "o", "r", 1, "jumi")
    ).toBe(true);
    expect(await hasJumiAuthoredCommit({}, "o", "r", 1, "jumi")).toBe(false);
    const adopted = adoptedPr();
    expect(
      await isPrTitleRetitleEligible(
        { listPullCommits: async () => [jumiCommit()] },
        adopted,
        { botUsername: "jumi", branchPrefix: "jumi" },
        { state: "loaded", load: { state: "missing" } },
        "kirmanak",
        "demo"
      )
    ).toBe(true);
  });
});
