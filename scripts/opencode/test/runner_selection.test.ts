import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginClaimedWorktree, isClaimedEarlyResult } from "../src/claimed_worktree.ts";
import { loadConfig } from "../src/config.ts";
import type { Engine, EngineResult } from "../src/engine.ts";
import { withEngineChain } from "../src/fallback.ts";
import { resolveIndependentReviewers } from "../src/independent_review.ts";
import { type ReviewApi, reviewPullRequest } from "../src/review.ts";
import {
  chooseRandomStartIndex,
  describeAttemptOrder,
  type NamedRunner,
  orderChainForJob,
  orderedRunners,
  parseRunnersCatalog,
  RUNNER_SELECTION_ORDERED,
  RUNNER_SELECTION_RANDOM_START,
  resolveRunnerSelection,
  rotateChainForStart,
} from "../src/runners.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";
import { emptyCiMethods, makeComment, makeFile, makeIssue, makePR, makeRepo } from "./fixtures.ts";

const spark: NamedRunner = { name: "spark", type: "opencode", model: "provider-a/spark", variant: "xhigh" };
const grok: NamedRunner = { name: "grok", type: "opencode", model: "provider-b/grok", variant: "high" };
const claude: NamedRunner = { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" };

function ok(model: string): EngineResult {
  return { status: "ok", exitCode: 0, stdout: model };
}

const unavailable: EngineResult = {
  status: "exit",
  exitCode: 1,
  message: "opencode exited with code 1:\n429 rate limit exceeded",
};

describe("runner selection config", () => {
  test("absent selection defaults to ordered", () => {
    const catalog = parseRunnersCatalog({
      runners: { a: { type: "opencode", model: "a/m" } },
      chain: ["a"],
    });
    expect(catalog.selection).toBeUndefined();
    expect(resolveRunnerSelection(catalog)).toBe(RUNNER_SELECTION_ORDERED);
    expect(resolveRunnerSelection({})).toBe(RUNNER_SELECTION_ORDERED);
  });

  test("explicit ordered and random-start round-trip", () => {
    expect(
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/m" } },
        chain: ["a"],
        selection: "ordered",
      }).selection
    ).toBe("ordered");
    expect(
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/m" } },
        chain: ["a"],
        selection: "random-start",
      }).selection
    ).toBe("random-start");
  });

  test("invalid selection fails clearly at load", () => {
    for (const bad of ["round-robin", "RANDOM-START", "random", "", 123, true]) {
      expect(() =>
        parseRunnersCatalog({
          runners: { a: { type: "opencode", model: "a/m" } },
          chain: ["a"],
          selection: bad,
        })
      ).toThrow("selection");
    }
    expect(() => resolveRunnerSelection({ selection: "round-robin" })).toThrow("selection");
  });

  test("reviewer and worker configs default ordered and accept random-start files", () => {
    const required = {
      GITEA_URL: "https://gitea.example/",
      GITEA_BOT_TOKEN: "token",
      GITEA_WEBHOOK_SECRET: "secret",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
    };
    expect(loadConfig(required).runnerSelection).toBe(RUNNER_SELECTION_ORDERED);
    expect(
      loadWorkerConfig({
        GITEA_URL: "https://gitea.example/",
        GITEA_BOT_TOKEN: "token",
        GITEA_WEBHOOK_SECRET: "secret",
      }).runnerSelection
    ).toBe(RUNNER_SELECTION_ORDERED);

    const dir = mkdtempSync(join(tmpdir(), "jumi-selection-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: {
          a: { type: "opencode", model: "a/m" },
          b: { type: "opencode", model: "b/m" },
        },
        chain: ["a", "b"],
        selection: "random-start",
      })
    );
    expect(loadConfig({ ...required, JUMI_RUNNERS_FILE: file }).runnerSelection).toBe(RUNNER_SELECTION_RANDOM_START);
    expect(
      loadWorkerConfig({
        GITEA_URL: "https://gitea.example/",
        GITEA_BOT_TOKEN: "token",
        GITEA_WEBHOOK_SECRET: "secret",
        JUMI_RUNNERS_FILE: file,
      }).runnerSelection
    ).toBe(RUNNER_SELECTION_RANDOM_START);

    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        runners: { a: { type: "opencode", model: "a/m" } },
        chain: ["a"],
        selection: "round-robin",
      })
    );
    expect(() => loadConfig({ ...required, JUMI_RUNNERS_FILE: bad })).toThrow("selection");
  });

  test("synthesized env-compatible chains stay ordered", () => {
    const required = {
      GITEA_URL: "https://gitea.example/",
      GITEA_BOT_TOKEN: "token",
      GITEA_WEBHOOK_SECRET: "secret",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
    };
    const config = loadConfig({
      ...required,
      OPENCODE_MODEL: "provider-a/one",
      OPENCODE_FALLBACK_MODEL: "provider-b/two",
    });
    expect(config.chain).toEqual(["primary", "fallback"]);
    expect(config.runnerSelection).toBe(RUNNER_SELECTION_ORDERED);
    const ordered = orderedRunners(config);
    expect(orderChainForJob(ordered, config.runnerSelection, () => 0.99).map((r) => r.name)).toEqual([
      "primary",
      "fallback",
    ]);
  });
});

describe("rotation helpers", () => {
  test("every eligible runner can be selected as the start", () => {
    expect(chooseRandomStartIndex(3, () => 0)).toBe(0);
    expect(chooseRandomStartIndex(3, () => 0.34)).toBe(1);
    expect(chooseRandomStartIndex(3, () => 0.67)).toBe(2);
    expect(chooseRandomStartIndex(3, () => 0.99)).toBe(2);
    const chain = [spark, grok, claude];
    expect(rotateChainForStart(chain, 0).map((r) => r.name)).toEqual(["spark", "grok", "claude"]);
    expect(rotateChainForStart(chain, 1).map((r) => r.name)).toEqual(["grok", "claude", "spark"]);
    expect(rotateChainForStart(chain, 2).map((r) => r.name)).toEqual(["claude", "spark", "grok"]);
  });

  test("ordered mode keeps configured order", () => {
    const chain = [spark, grok, claude];
    expect(orderChainForJob(chain, "ordered", () => 0.99).map((r) => r.name)).toEqual(["spark", "grok", "claude"]);
    expect(orderChainForJob(chain, undefined, () => 0.99).map((r) => r.name)).toEqual(["spark", "grok", "claude"]);
  });

  test("singleton chains behave as before", () => {
    expect(orderChainForJob([spark], "random-start", () => 0.99)).toEqual([spark]);
    expect(rotateChainForStart([spark], 5)).toEqual([spark]);
    expect(describeAttemptOrder([spark])).toBe("spark");
  });

  test("rotation does not mutate input and jobs do not share state", () => {
    const original = [spark, grok, claude];
    const snapshot = original.map((r) => r.name);
    const first = orderChainForJob(original, "random-start", () => 0.5);
    const second = orderChainForJob(original, "random-start", () => 0.0);
    expect(original.map((r) => r.name)).toEqual(snapshot);
    expect(first).not.toBe(original);
    expect(second).not.toBe(original);
    expect(first).not.toBe(second);
    first.push(spark);
    expect(original.length).toBe(3);
    expect(second.length).toBe(3);
  });

  test("dormant catalog entries never become candidates", () => {
    const catalog = parseRunnersCatalog({
      runners: {
        a: { type: "opencode", model: "a/m" },
        b: { type: "opencode", model: "b/m" },
        dormant: { type: "opencode", model: "d/m" },
      },
      chain: ["a", "b"],
      selection: "random-start",
    });
    const eligible = orderedRunners(catalog);
    expect(eligible.map((r) => r.name)).toEqual(["a", "b"]);
    for (const random of [() => 0, () => 0.6, () => 0.99]) {
      const ordered = orderChainForJob(eligible, catalog.selection, random);
      expect(ordered.map((r) => r.name).includes("dormant")).toBe(false);
      expect(ordered.length).toBe(2);
    }
  });
});

describe("withEngineChain random-start", () => {
  test("wraparound fallback reaches all eligible runners without repeats", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (models.length < 3) return unavailable;
      return ok(opts.model);
    };
    // Start at grok (index 1): order grok->claude->spark.
    const result = await withEngineChain(engine, {
      chain: [spark, grok, claude],
      selection: "random-start",
      random: () => 0.5,
    })({ model: spark.model, workdir: "/tmp" });
    expect(models).toEqual([grok.model, claude.model, spark.model]);
    expect(result.runner?.model).toBe(spark.model);
    expect(result.chainIndex).toBe(2);
  });

  test("ordered default still starts at chain entry zero", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return ok(opts.model);
    };
    await withEngineChain(engine, { chain: [spark, grok] })({ model: spark.model, workdir: "/tmp" });
    expect(models).toEqual([spark.model]);
  });

  test("continuation after initial selection stays on the selected runner", async () => {
    const calls: string[] = [];
    const engine: Engine = async (opts) => {
      calls.push(opts.model);
      return ok(opts.model);
    };
    const run = withEngineChain(engine, {
      chain: [spark, grok, claude],
      selection: "random-start",
      random: () => 0.99,
    });
    const first = await run({ model: spark.model, workdir: "/tmp" });
    expect(first.runner?.model).toBe(claude.model);
    // A same-session continuation must not rerandomize, even though a fresh
    // draw would pick a different start.
    const second = await run({ model: spark.model, workdir: "/tmp", continueSession: true });
    expect(second.runner?.model).toBe(claude.model);
    expect(calls).toEqual([claude.model, claude.model]);
  });

  test("continuation after a hop stays on the hopped runner", async () => {
    const calls: string[] = [];
    const engine: Engine = async (opts) => {
      calls.push(opts.model);
      if (opts.model === grok.model && !opts.continueSession) return unavailable;
      return ok(opts.model);
    };
    const run = withEngineChain(engine, {
      chain: [spark, grok, claude],
      selection: "random-start",
      random: () => 0.5,
    });
    // Starts at grok, hops to claude.
    const first = await run({ model: spark.model, workdir: "/tmp" });
    expect(first.runner?.model).toBe(claude.model);
    const second = await run({ model: spark.model, workdir: "/tmp", continueSession: true });
    expect(second.runner?.model).toBe(claude.model);
    expect(calls).toEqual([grok.model, claude.model, claude.model]);
  });

  test("lease refusal still applies under random-start", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const result = await withEngineChain(engine, {
      chain: [spark, grok],
      selection: "random-start",
      random: () => 0.99,
      remainingLeaseMs: () => 1_000,
    })({ model: spark.model, workdir: "/tmp", timeoutMs: 900_000 });
    // Starts at grok (last entry): no next runner, so no hop.
    expect(models).toEqual([grok.model]);
    expect(result.runner?.model).toBe(grok.model);
  });

  test("invalid selection fails clearly", () => {
    const engine: Engine = async () => ok("m");
    expect(() => withEngineChain(engine, { chain: [spark], selection: "round-robin" })).toThrow("selection");
  });

  test("catalog ordering is not mutated by engine runs", async () => {
    const configured = [spark, grok, claude];
    const snapshot = configured.map((r) => r.name);
    const engine: Engine = async (opts) => ok(opts.model);
    await withEngineChain(engine, {
      chain: configured,
      selection: "random-start",
      random: () => 0.7,
    })({ model: spark.model, workdir: "/tmp" });
    expect(configured.map((r) => r.name)).toEqual(snapshot);
  });
});

describe("independent review plus selection", () => {
  const policy = {
    enabled: true as const,
    groups: {
      opus: [{ type: "claude", model: "claude-opus-5" }],
      grok: [{ type: "opencode", model: "xai/grok-4.6" }],
    },
  };

  test("excluded families stay excluded on every fallback", () => {
    const chain: NamedRunner[] = [
      { name: "opus-review", type: "claude", model: "claude-opus-5", effort: "high" },
      { name: "grok-review", type: "opencode", model: "xai/grok-4.6" },
    ];
    const outcome = resolveIndependentReviewers({
      chain,
      provenance: {
        status: "known",
        forge: "gitea",
        owner: "o",
        repo: "r",
        prNumber: 1,
        branch: "b",
        headSha: "h",
        contributors: [{ type: "opencode", model: "xai/grok-4.6" }],
        publisher: null,
      },
      policy,
      headSha: "h",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") throw new Error("expected selected");
    expect(outcome.eligible.map((r) => r.name)).toEqual(["opus-review"]);
    // A singleton eligible chain behaves as before under random-start.
    const ordered = orderChainForJob(outcome.eligible, "random-start", () => 0.99);
    expect(ordered.map((r) => r.name)).toEqual(["opus-review"]);
  });

  test("no eligible reviewer stays fail-closed", () => {
    const chain: NamedRunner[] = [{ name: "grok-review", type: "opencode", model: "xai/grok-4.6" }];
    const outcome = resolveIndependentReviewers({
      chain,
      provenance: {
        status: "known",
        forge: "gitea",
        owner: "o",
        repo: "r",
        prNumber: 1,
        branch: "b",
        headSha: "h",
        contributors: [{ type: "opencode", model: "xai/grok-4.6" }],
        publisher: null,
      },
      policy,
      headSha: "h",
    });
    expect(outcome.kind).toBe("refused");
  });
});

function makeReviewApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_o, _r, _i, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_o, _r, id, body) => makeComment({ id, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_o, _r, _s, status) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  } as ReviewApi;
}

describe("integrated reviewer and worker paths", () => {
  test("reviewer honors random-start and keeps the post-hop stamp", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-selection-review-"));
    try {
      const seenModels: string[] = [];
      const logs: string[] = [];
      const chain: NamedRunner[] = [spark, grok, claude];
      const result = await reviewPullRequest({
        api: makeReviewApi(),
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: spark.model,
        variant: spark.variant,
        chain,
        runnerSelection: "random-start",
        // Picks grok as the start.
        runnerRandom: () => 0.5,
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          if (args[0] === "ls-files") return "";
          if (args[0] === "checkout") return "";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        logger: (message) => {
          logs.push(message);
        },
        engine: async (opts) => {
          seenModels.push(opts.model);
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" as const };
        },
      });
      expect(result.status).toBe("posted");
      // Random-start picked grok; no hop was needed so the first spawn ran.
      expect(seenModels[0]).toBe(grok.model);
      expect(logs.join("\n")).toContain("runner_selection");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reviewer ordered default still starts at chain entry zero", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-selection-ordered-"));
    try {
      const seenModels: string[] = [];
      await reviewPullRequest({
        api: makeReviewApi(),
        owner: "o",
        repo: "r",
        prNumber: 7,
        model: spark.model,
        variant: spark.variant,
        chain: [spark, grok],
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          if (args[0] === "ls-files") return "";
          if (args[0] === "checkout") return "";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        logger: () => undefined,
        engine: async (opts) => {
          seenModels.push(opts.model);
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" as const };
        },
      });
      expect(seenModels[0]).toBe(spark.model);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("worker claimed worktree rotates per job and does not share order", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-selection-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-selection-work-"));
    try {
      const fakeEngine: Engine = async (opts) => ok(opts.model);
      const first = await beginClaimedWorktree({
        job: { owner: "o", repo: "r", issueNumber: 1, issueUpdatedAt: new Date().toISOString() },
        home,
        workdir,
        fallbackEngine: fakeEngine,
        chain: [spark, grok, claude],
        runnerSelection: "random-start",
        runnerRandom: () => 0.99,
        useClaim: false,
      });
      const second = await beginClaimedWorktree({
        job: { owner: "o", repo: "r", issueNumber: 2, issueUpdatedAt: new Date().toISOString() },
        home,
        workdir,
        fallbackEngine: fakeEngine,
        chain: [spark, grok, claude],
        runnerSelection: "random-start",
        runnerRandom: () => 0,
        useClaim: false,
      });
      if (isClaimedEarlyResult(first) || isClaimedEarlyResult(second)) throw new Error("expected claims");
      expect(first.effectiveChain?.map((r) => r.name)).toEqual(["claude", "spark", "grok"]);
      expect(second.effectiveChain?.map((r) => r.name)).toEqual(["spark", "grok", "claude"]);
      // Mutating one job's order must not affect the other.
      first.effectiveChain?.push(spark);
      expect(second.effectiveChain?.length).toBe(3);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
