import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementIssue } from "../src/implement.ts";
import {
  applyRepoChain,
  invalidRepoSettingsReason,
  narrowChainForRepo,
  noAllowedRunnerReason,
  parseRepoSettingsText,
  resolveRepoChain,
} from "../src/repo_settings.ts";
import { reviewPullRequest } from "../src/review.ts";
import { emptyCiMethods, makeBranch, makeComment, makeFile, makeIssue, makePR, makeRepo } from "./fixtures.ts";

function chain() {
  return [
    { name: "grok", type: "opencode" as const, model: "xai/grok-4.6" },
    { name: "opus", type: "claude" as const, model: "claude-opus-5" },
  ];
}

describe("allowed_runners parsing", () => {
  test("absent means unrestricted", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        allowedRunners: undefined,
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("list parses, trims, and dedupes", () => {
    expect(parseRepoSettingsText("allowed_runners: [grok, opus, grok]\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        allowedRunners: ["grok", "opus"],
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("empty list is invalid", () => {
    expect(parseRepoSettingsText("allowed_runners: []\n")).toEqual({
      ok: false,
      error:
        '"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only',
    });
  });

  test("blank or non-string entries are invalid", () => {
    for (const text of [
      "allowed_runners: [grok, '  ']\n",
      'allowed_runners: [""]\n',
      "allowed_runners: [grok, 42]\n",
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"allowed_runners" must not contain blank entries' });
    }
  });

  test("wrong types are invalid", () => {
    for (const text of ["allowed_runners: grok\n", "allowed_runners: null\n"]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: `"allowed_runners" must be a list of runner names` });
    }
  });
});

describe("narrowChainForRepo", () => {
  test("undefined keeps the full chain in order", () => {
    const narrowed = narrowChainForRepo(chain(), undefined);
    expect(narrowed.chain.map((r) => r.name)).toEqual(["grok", "opus"]);
    expect(narrowed.unknownNames).toEqual([]);
  });

  test("names one of two keeps only that entry", () => {
    const logs: string[] = [];
    const narrowed = narrowChainForRepo(chain(), ["opus"], (m) => logs.push(m));
    expect(narrowed.chain.map((r) => r.name)).toEqual(["opus"]);
    expect(narrowed.unknownNames).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("unknown names grant nothing and are logged", () => {
    const logs: string[] = [];
    const narrowed = narrowChainForRepo(chain(), ["opus", "nope"], (m) => logs.push(m));
    expect(narrowed.chain.map((r) => r.name)).toEqual(["opus"]);
    expect(narrowed.unknownNames).toEqual(["nope"]);
    expect(logs.join(" ")).toContain("nope");
  });

  test("only unknown names narrows to empty", () => {
    const narrowed = narrowChainForRepo(chain(), ["nope"], () => undefined);
    expect(narrowed.chain).toEqual([]);
    expect(narrowed.unknownNames).toEqual(["nope"]);
  });
});

describe("resolveRepoChain", () => {
  test("missing file is unrestricted", async () => {
    const res = await resolveRepoChain({
      api: { getRepoFile: async () => ({ found: false }) },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      chain: chain(),
      log: () => undefined,
    });
    expect(res.state).toBe("unrestricted");
  });

  test("invalid file fails closed", async () => {
    const res = await resolveRepoChain({
      api: { getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      chain: chain(),
      log: () => undefined,
    });
    expect(res.state).toBe("invalid");
    if (res.state === "invalid") expect(res.reason).toContain(".jumi.yml is invalid");
  });

  test("empty match fails closed with the settings reason", async () => {
    const res = await resolveRepoChain({
      api: { getRepoFile: async () => ({ found: true, content: "allowed_runners: [nope]\n" }) },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      chain: chain(),
      log: () => undefined,
    });
    expect(res.state).toBe("empty");
    if (res.state === "empty") {
      expect(res.reason).toContain("repository settings left no eligible runner");
      expect(res.reason).toContain("o/r");
    }
  });

  test("unreadable throws so the caller can fail open", async () => {
    await expect(
      resolveRepoChain({
        api: {
          getRepoFile: async () => {
            throw new Error("GitHub API → 500");
          },
        },
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        chain: chain(),
        log: () => undefined,
      })
    ).rejects.toThrow("500");
  });

  test("reason helpers name the cause", () => {
    expect(invalidRepoSettingsReason("boom")).toBe(".jumi.yml is invalid: boom");
    expect(noAllowedRunnerReason("o", "r", ["a"])).toContain("repository settings left no eligible runner for o/r");
  });
});

function reviewApi(overrides: Record<string, unknown> = {}) {
  const statuses: Array<{ state: string; description: string }> = [];
  const base = {
    getRepo: async () => makeRepo({ default_branch: "main" }),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_o: string, _r: string, _i: number, body: string) => makeComment({ id: 1, body }),
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
      _sha: string,
      status: { state: string; description: string }
    ) => {
      statuses.push({ state: status.state, description: status.description });
      return status;
    },
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" as const }],
    getRepoFile: async () => ({ found: false as const }),
    ...overrides,
  };
  return { api: base as never, statuses };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-repo-runners-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("review runner allow-list", () => {
  test("invalid default-branch file posts failure and runs no runner", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const { api, statuses } = reviewApi({
        getRepoFile: async () => ({ found: true, content: "nope: 1\n" }),
      });
      const result = await reviewPullRequest({
        api: api as never,
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        logger: () => undefined,
        chain: chain() as never,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      } as never);
      expect(ran).toBe(0);
      expect(result.status).toBe("skipped");
      expect(result.reason).toContain(".jumi.yml is invalid");
      expect(statuses.at(-1)?.state).toBe("failure");
      expect(statuses.at(-1)?.description).toContain(".jumi.yml is invalid");
    });
  });

  test("allow-list matching nothing posts failure and runs no runner", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const { api, statuses } = reviewApi({
        getRepoFile: async () => ({ found: true, content: "allowed_runners: [nope]\n" }),
      });
      const result = await reviewPullRequest({
        api: api as never,
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        logger: () => undefined,
        chain: chain() as never,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      } as never);
      expect(ran).toBe(0);
      expect(result.reason).toContain("repository settings left no eligible runner");
      expect(statuses.at(-1)?.state).toBe("failure");
    });
  });

  test("allow-list naming one of two runs on that runner", async () => {
    await withWorkspace(async (workspace) => {
      const seen: string[] = [];
      const { api } = reviewApi({
        getRepoFile: async () => ({ found: true, content: "allowed_runners: [opus]\n" }),
      });
      const result = await reviewPullRequest({
        api: api as never,
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner: async (args: string[]) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          if (args[0] === "ls-files") return "";
          if (args[0] === "checkout") return "";
          if (args[0] === "ls-tree") return "";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        logger: () => undefined,
        chain: chain() as never,
        openCodeRunner: async (opts: { model: string; workdir: string }) => {
          seen.push(opts.model);
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "file.ts:1: 🟡 note\n<!-- jumi-check: failure -->");
          return { status: "ok" };
        },
      } as never);
      expect(result.status).toBe("posted");
      expect(seen).toEqual(["claude-opus-5"]);
    });
  });
});

describe("worker runner allow-list", () => {
  test("invalid file posts once and runs no runner", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-impl-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-impl-work-"));
    try {
      const comments: string[] = [];
      const api = {
        getRepo: async () => makeRepo(),
        getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
        getIssue: async () => makeIssue(),
        getPR: async (_o: string, _r: string, n: number) => makePR({ number: n }),
        listOpenPulls: async () => [],
        createPullRequest: async () => makePR({ number: 3 }),
        closePullRequest: async (_o: string, _r: string, n: number) => makePR({ number: n, state: "closed" }),
        updatePullRequestBody: async (_o: string, _r: string, n: number, body: string) => makePR({ number: n, body }),
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
          comments.push(body);
          return makeComment({ body });
        },
        updateIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
          comments.push(body);
          return makeComment({ body });
        },
        listIssueComments: async () => [],
        listPullReviewComments: async () => [],
        listPullReviews: async () => [],
        ...emptyCiMethods(),
        getRepoFile: async () => ({ found: true, content: "bad: 1\n" }),
      };
      let ran = 0;
      const { makeIssueJob } = await import("./fixtures.ts");
      const result = await implementIssue({
        api: api as never,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          ran++;
          throw new Error("runner should not run");
        },
        logger: () => undefined,
        chain: chain() as never,
      });
      expect(ran).toBe(0);
      expect(result).toEqual({ status: "skipped", reason: expect.stringContaining(".jumi.yml is invalid") });
      expect(comments.some((c) => c.includes(".jumi.yml is invalid"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("empty allow-list posts once and runs no runner", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-impl-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-impl-work-"));
    try {
      const comments: string[] = [];
      const api = {
        getRepo: async () => makeRepo(),
        getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
        getIssue: async () => makeIssue(),
        getPR: async (_o: string, _r: string, n: number) => makePR({ number: n }),
        listOpenPulls: async () => [],
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
          comments.push(body);
          return makeComment({ body });
        },
        updateIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
          comments.push(body);
          return makeComment({ body });
        },
        listIssueComments: async () => [],
        listPullReviewComments: async () => [],
        listPullReviews: async () => [],
        ...emptyCiMethods(),
        getRepoFile: async () => ({ found: true, content: "allowed_runners: [nope]\n" }),
      };
      let ran = 0;
      const { makeIssueJob } = await import("./fixtures.ts");
      const result = await implementIssue({
        api: api as never,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          ran++;
          throw new Error("runner should not run");
        },
        logger: () => undefined,
        chain: chain() as never,
      });
      expect(ran).toBe(0);
      expect(result).toEqual({
        status: "skipped",
        reason: expect.stringContaining("repository settings left no eligible runner"),
      });
      expect(comments.some((c) => c.includes("repository settings left no eligible runner"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("writer-only allow-list refuses independent review like an empty eligible set", async () => {
    const { MemoryProvenanceStore } = await import("../src/provenance.ts");
    const store = new MemoryProvenanceStore();
    const writer = { type: "claude", model: "claude-opus-5" };
    await store.confirmPublication({
      forge: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      branch: "feature",
      headSha: "head1",
      contributors: [{ ...writer }],
      publisher: { ...writer },
      jobId: 1,
      jobKey: "k",
      delivery: "d",
      jobKind: "implement",
    });
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      let ran = 0;
      const { api } = reviewApi({
        getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }),
        getRepoFile: async () => ({ found: true, content: "allowed_runners: [opus]\n" }),
        createCommitStatus: async (
          _o: string,
          _r: string,
          _s: string,
          status: { state: string; description?: string }
        ) => {
          statuses.push(status);
          return status;
        },
      });
      const result = await reviewPullRequest({
        api: api as never,
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "t",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner: async (args: string[]) => {
          if (args[0] === "rev-parse") return "head1";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          if (args[0] === "ls-files") return "";
          if (args[0] === "checkout") return "";
          if (args[0] === "ls-tree") return "";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        logger: () => undefined,
        chain: chain() as never,
        independentReview: {
          enabled: true,
          groups: {
            opus: [{ type: "claude", model: "claude-opus-5" }],
            grok: [{ type: "opencode", model: "xai/grok-4.6" }],
          },
        },
        provenance: store as never,
        forgeKind: "gitea",
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      } as never);
      expect(ran).toBe(0);
      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("Independent review unavailable");
      expect(result.reason).toContain("no eligible reviewer");
      expect(statuses.at(-1)?.state).toBe("failure");
    });
  });
});

describe("applyRepoChain fail-closed ordering", () => {
  test("unreadable resolves fail-open without publishing", async () => {
    let published = 0;
    const applied = await applyRepoChain({
      api: {
        getRepoFile: async () => {
          throw new Error("GitHub API → 500");
        },
      },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      chain: chain(),
      log: () => undefined,
      publish: async () => {
        published++;
      },
    });
    expect(published).toBe(0);
    expect(applied.failedClosed).toBe(false);
    if (!applied.failedClosed) {
      expect(applied.narrowed).toBe(false);
      expect(applied.chain?.map((r) => r.name)).toEqual(["grok", "opus"]);
    }
  });

  test("publish failure propagates instead of continuing on the full chain", async () => {
    let published = 0;
    await expect(
      applyRepoChain({
        api: { getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) },
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        chain: chain(),
        log: () => undefined,
        publish: async () => {
          published++;
          throw new Error("status store unavailable");
        },
      })
    ).rejects.toThrow("status store unavailable");
    expect(published).toBe(1);
  });

  test("review fail-closed status failure runs no runner", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const { api } = reviewApi({
        getRepoFile: async () => ({ found: true, content: "nope: 1\n" }),
        createCommitStatus: async () => {
          throw new Error("status store unavailable");
        },
      });
      await expect(
        reviewPullRequest({
          api: api as never,
          owner: "o",
          repo: "r",
          prNumber: 7,
          model: "openai/gpt-5.5",
          workspace,
          giteaUrl: "https://gitea.example",
          giteaToken: "t",
          botUsername: "jumi",
          workspacePreparer: async () => undefined,
          logger: () => undefined,
          chain: chain() as never,
          openCodeRunner: async () => {
            ran++;
            return { status: "ok" };
          },
        } as never)
      ).rejects.toThrow("status store unavailable");
      expect(ran).toBe(0);
    });
  });
});
