import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX,
  PROVENANCE_UNKNOWN_DIAGNOSTIC,
  resolveIndependentReviewers,
} from "../src/independent_review.ts";
import { MemoryProvenanceStore } from "../src/provenance.ts";
import { isTerminalSkipReason, type ReviewApi, reviewPullRequest } from "../src/review.ts";
import { parseRunnersCatalog } from "../src/runners.ts";
import { emptyCiMethods, makeBranch, makeComment, makeFile, makeIssue, makePR, makeRepo } from "./fixtures.ts";

const OPUS_CLAUDE = { type: "claude", model: "claude-opus-5", effort: "high" };
const OPUS_OPENCODE_ALIAS = { type: "opencode", model: "anthropic/claude-opus-5", variant: "high" };
const GROK_OPENCODE = { type: "opencode", model: "xai/grok-4.6", variant: "high" };
const GROK_CLAUDE_ALIAS = { type: "claude", model: "xai/grok-4.6", effort: "high" };

function policy() {
  return {
    enabled: true,
    groups: {
      opus: [
        { type: "claude", model: "claude-opus-5" },
        { type: "opencode", model: "anthropic/claude-opus-5" },
      ],
      grok: [
        { type: "opencode", model: "xai/grok-4.6" },
        { type: "claude", model: "xai/grok-4.6" },
      ],
    },
  };
}

function chain() {
  return [
    { name: "opus-review", type: "claude" as const, model: "claude-opus-5", effort: "high" },
    { name: "grok-review", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" },
  ];
}

function knownProvenance(contributors: import("../src/runners.ts").RunnerStamp[]) {
  return {
    status: "known" as const,
    forge: "gitea",
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    branch: "jumi/issue-12-a",
    headSha: "head1",
    contributors,
    publisher: contributors[contributors.length - 1] ?? null,
  };
}

describe("parseRunnersCatalog independentReview", () => {
  test("absent policy preserves today's behavior", () => {
    const catalog = parseRunnersCatalog({
      runners: { a: { type: "opencode", model: "m" } },
      chain: ["a"],
    });
    expect(catalog.independentReview).toBeUndefined();
  });

  test("disabled flag preserves behavior", () => {
    const catalog = parseRunnersCatalog({
      runners: { a: { type: "opencode", model: "m" } },
      chain: ["a"],
      independentReview: { enabled: false, groups: {} },
    });
    expect(catalog.independentReview).toBeUndefined();
  });

  test("enabled policy parses explicit groups", () => {
    const catalog = parseRunnersCatalog({
      runners: {
        o: { type: "claude", model: "claude-opus-5", effort: "high" },
        g: { type: "opencode", model: "xai/grok-4.6" },
      },
      chain: ["o", "g"],
      independentReview: {
        enabled: true,
        groups: {
          opus: [{ type: "claude", model: "claude-opus-5" }],
          grok: [{ type: "opencode", model: "xai/grok-4.6" }],
        },
      },
    });
    expect(catalog.independentReview?.enabled).toBe(true);
    expect(Object.keys(catalog.independentReview?.groups ?? {})).toEqual(["opus", "grok"]);
  });

  test("contradictory mappings fail closed at load", () => {
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "m" } },
        chain: ["a"],
        independentReview: {
          enabled: true,
          groups: {
            opus: [{ type: "claude", model: "x" }],
            grok: [{ type: "claude", model: "x" }],
          },
        },
      })
    ).toThrow("contradictory");
  });

  test("empty groups fail closed at load", () => {
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "m" } },
        chain: ["a"],
        independentReview: { enabled: true, groups: {} },
      })
    ).toThrow("must not be empty");
  });
});

describe("resolveIndependentReviewers", () => {
  test("Opus-written heads select Grok, Grok-written select Opus", () => {
    const opusWritten = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([OPUS_CLAUDE]),
      policy: policy(),
      headSha: "head1",
    });
    expect(opusWritten.kind).toBe("selected");
    if (opusWritten.kind === "selected") expect(opusWritten.chosen.name).toBe("grok-review");

    const grokWritten = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([GROK_OPENCODE]),
      policy: policy(),
      headSha: "head1",
    });
    expect(grokWritten.kind).toBe("selected");
    if (grokWritten.kind === "selected") expect(grokWritten.chosen.name).toBe("opus-review");
  });

  test("same-family aliases across harnesses are excluded", () => {
    const outcome = resolveIndependentReviewers({
      chain: [
        { name: "opus-a", type: "claude", model: "claude-opus-5", effort: "high" },
        { name: "opus-b", type: "opencode", model: "anthropic/claude-opus-5", variant: "high" },
        { name: "grok", type: "opencode", model: "xai/grok-4.6", variant: "high" },
      ],
      provenance: knownProvenance([OPUS_CLAUDE]),
      policy: policy(),
      headSha: "h",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") {
      expect(outcome.eligible.map((r) => r.name)).toEqual(["grok"]);
      expect(outcome.chosen.name).toBe("grok");
    }
  });

  test("effort levels do not change the family", () => {
    const outcome = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([{ type: "claude", model: "claude-opus-5", effort: "low" }]),
      policy: policy(),
      headSha: "h",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") expect(outcome.chosen.name).toBe("grok-review");
  });

  test("mixed known authorship excludes all its families", () => {
    const outcome = resolveIndependentReviewers({
      chain: [...chain(), { name: "third", type: "codex", model: "gpt-6", effort: "high" }],
      provenance: knownProvenance([OPUS_CLAUDE, GROK_OPENCODE]),
      policy: {
        enabled: true,
        groups: {
          ...policy().groups,
          gpt: [{ type: "codex", model: "gpt-6" }],
        },
      },
      headSha: "h",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") expect(outcome.chosen.name).toBe("third");
  });

  test("filtering to none fails closed without success", () => {
    const outcome = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([OPUS_CLAUDE, GROK_OPENCODE]),
      policy: policy(),
      headSha: "headX",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason.startsWith(INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX)).toBe(true);
      expect(isTerminalSkipReason(outcome.reason)).toBe(true);
    }
  });

  test("unmapped writer fails closed rather than reinterpreting as primary", () => {
    const outcome = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([{ type: "opencode", model: "old/legacy-model" }]),
      policy: policy(),
      headSha: "oldhead",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toContain("unmapped");
  });

  test("unmapped candidate fails closed", () => {
    const outcome = resolveIndependentReviewers({
      chain: [...chain(), { name: "new", type: "opencode", model: "new/model" }],
      provenance: knownProvenance([OPUS_CLAUDE]),
      policy: policy(),
      headSha: "h",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toContain("reviewer lacks");
  });

  test("dormant catalog entries are never eligible", () => {
    // Dormant runner shares grok family but is not in the active chain.
    const outcome = resolveIndependentReviewers({
      chain: [{ name: "opus-review", type: "claude", model: "claude-opus-5", effort: "high" }],
      provenance: knownProvenance([OPUS_CLAUDE]),
      policy: policy(),
      headSha: "h",
    });
    // Only the active chain filters; the dormant grok runner cannot rescue it.
    expect(outcome.kind).toBe("refused");
  });

  test("unknown external authorship follows the ordinary chain", () => {
    const outcome = resolveIndependentReviewers({
      chain: chain(),
      provenance: {
        status: "unknown",
        forge: "gitea",
        owner: "o",
        repo: "r",
        prNumber: 7,
        branch: "b",
        headSha: "ext",
        contributors: [],
        publisher: null,
      },
      policy: policy(),
      headSha: "ext",
    });
    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") {
      expect(outcome.eligible.map((r) => r.name)).toEqual(["opus-review", "grok-review"]);
      expect(outcome.diagnostics.reason).toBe(PROVENANCE_UNKNOWN_DIAGNOSTIC);
    }
  });

  test("pending and failed provenance never bypass the rule", () => {
    for (const status of ["pending", "failed"] as const) {
      const outcome = resolveIndependentReviewers({
        chain: chain(),
        provenance: {
          status,
          forge: "gitea",
          owner: "o",
          repo: "r",
          prNumber: 7,
          branch: "b",
          headSha: "h",
          contributors: [],
          publisher: null,
        },
        policy: policy(),
        headSha: "h",
      });
      expect(outcome.kind).toBe("refused");
    }
  });

  test("disabled policy preserves today's chain without lookup", () => {
    const outcome = resolveIndependentReviewers({
      chain: chain(),
      provenance: knownProvenance([OPUS_CLAUDE]),
      policy: undefined,
      headSha: "h",
    });
    expect(outcome.kind).toBe("disabled");
    if (outcome.kind === "disabled")
      expect(outcome.eligible.map((r) => r.name)).toEqual(["opus-review", "grok-review"]);
  });

  test("same-model cross-harness alias of the author is excluded", () => {
    const outcome = resolveIndependentReviewers({
      chain: [
        { name: "grok-opencode", type: "opencode", model: "xai/grok-4.6" },
        { name: "grok-claude", type: "claude", model: "xai/grok-4.6", effort: "high" },
        { name: "opus", type: "claude", model: "claude-opus-5", effort: "high" },
      ],
      provenance: knownProvenance([GROK_OPENCODE]),
      policy: policy(),
      headSha: "h",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") {
      expect(outcome.eligible.map((r) => r.name)).toEqual(["opus"]);
    }
    void GROK_CLAUDE_ALIAS;
    void OPUS_OPENCODE_ALIAS;
  });
});

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
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

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-ind-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function frozenGit(head = "head1"): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const baseOptions = {
  owner: "kirmanak",
  repo: "demo",
  prNumber: 7,
  model: "openai/gpt-5.5",
  workspace: "/work",
  giteaUrl: "https://gitea.kirmanak.stream",
  giteaToken: "bot-token",
  botUsername: "jumi",
  workspacePreparer: async () => undefined,
  logger: () => undefined,
};

describe("reviewPullRequest independent selection", () => {
  test("Opus-written head runs Grok; Grok-written runs Opus (post-hop writer wins)", async () => {
    for (const [writer, expectedModel] of [
      [OPUS_CLAUDE, "xai/grok-4.6"],
      [GROK_OPENCODE, "claude-opus-5"],
    ] as const) {
      const store = new MemoryProvenanceStore();
      await store.confirmPublication({
        forge: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        branch: "feature",
        headSha: "head1",
        contributors: [{ ...writer }],
        publisher: { ...writer },
        jobId: 1,
        jobKey: "implement:kirmanak/demo#12",
        delivery: "d1",
        jobKind: "implement",
      });
      await withWorkspace(async (workspace) => {
        const seen: string[] = [];
        const result = await reviewPullRequest({
          ...baseOptions,
          workspace,
          gitRunner: frozenGit("head1"),
          api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
          chain: chain(),
          independentReview: policy(),
          provenance: store,
          forgeKind: "gitea",
          engine: async (opts) => {
            seen.push(opts.model);
            await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
            return { status: "ok", runner: { type: opts.type ?? "opencode", model: opts.model } };
          },
        });
        expect(result).toEqual({ status: "posted" });
        expect(seen).toEqual([expectedModel]);
      });
    }
  });

  test("allowed hop never returns to the author family", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "feature",
      headSha: "head1",
      contributors: [{ ...OPUS_CLAUDE }],
      publisher: { ...OPUS_CLAUDE },
      jobId: 1,
      jobKey: "k",
      delivery: "d",
      jobKind: "implement",
    });
    await withWorkspace(async (workspace) => {
      const seen: string[] = [];
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
        chain: [
          { name: "grok-a", type: "opencode", model: "xai/grok-4.6", variant: "high" },
          { name: "grok-b", type: "claude", model: "xai/grok-4.6", effort: "high" },
          { name: "opus", type: "claude", model: "claude-opus-5", effort: "high" },
        ],
        independentReview: policy(),
        provenance: store,
        forgeKind: "gitea",
        engine: async (opts) => {
          seen.push(opts.model);
          if (seen.length === 1) {
            return { status: "exit", exitCode: 1, message: "429 rate limit exceeded" };
          }
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok", runner: { type: opts.type ?? "opencode", model: opts.model } };
        },
      });
      expect(result).toEqual({ status: "posted" });
      // First eligible (grok-a) fails over to second eligible (grok-b), never to the opus author.
      expect(seen).toEqual(["xai/grok-4.6", "xai/grok-4.6"]);
    });
  });

  test("no eligible reviewer fails closed with failure status and no artifact", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "feature",
      headSha: "head1",
      contributors: [{ ...OPUS_CLAUDE }, { ...GROK_OPENCODE }],
      publisher: { ...GROK_OPENCODE },
      jobId: 1,
      jobKey: "k",
      delivery: "d",
      jobKind: "implement",
    });
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      let ran = 0;
      const persisted: Array<{ kind: string; reason?: string }> = [];
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }),
          createCommitStatus: async (_o, _r, _s, status) => {
            statuses.push(status);
            return status;
          },
        }),
        chain: chain(),
        independentReview: policy(),
        provenance: store,
        forgeKind: "gitea",
        persistResult: async (value) => {
          persisted.push(value as { kind: string; reason?: string });
        },
        engine: async () => {
          ran++;
          return { status: "ok" };
        },
      });
      expect(result.status).toBe("skipped");
      expect(result.reason?.startsWith(INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX)).toBe(true);
      expect(ran).toBe(0);
      expect(statuses.at(-1)?.state).toBe("failure");
      expect(persisted[0]?.kind).toBe("skip");
    });
  });

  test("unknown external authorship uses the ordinary chain", async () => {
    const store = new MemoryProvenanceStore();
    await withWorkspace(async (workspace) => {
      const seen: string[] = [];
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
        chain: chain(),
        independentReview: policy(),
        provenance: store,
        forgeKind: "gitea",
        engine: async (opts) => {
          seen.push(opts.model);
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok", runner: { type: opts.type ?? "opencode", model: opts.model } };
        },
      });
      expect(result).toEqual({ status: "posted" });
      // Ordinary chain order preserved: first runner runs.
      expect(seen).toEqual(["claude-opus-5"]);
    });
  });

  test("pending provenance fails closed without running the model", async () => {
    const store = new MemoryProvenanceStore();
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 7,
      branch: "feature",
      jobId: 9,
      jobKey: "k",
      jobKind: "implement",
      delivery: "d",
    });
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
        chain: chain(),
        independentReview: policy(),
        provenance: store,
        forgeKind: "gitea",
        engine: async () => {
          ran++;
          return { status: "ok" };
        },
      });
      expect(result.reason?.startsWith(INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX)).toBe(true);
      expect(ran).toBe(0);
    });
  });

  test("provenance storage failure fails closed when enabled", async () => {
    const failing = {
      lookupForReview: async () => {
        throw new Error("db down");
      },
    } as unknown as MemoryProvenanceStore;
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
        chain: chain(),
        independentReview: policy(),
        provenance: failing,
        forgeKind: "gitea",
        engine: async () => {
          ran++;
          return { status: "ok" };
        },
      });
      expect(result.reason).toContain("lookup failed");
      expect(ran).toBe(0);
    });
  });

  test("moved heads keep current-head guards; reclaimed same head is deterministic", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "feature",
      headSha: "head1",
      contributors: [{ ...OPUS_CLAUDE }],
      publisher: { ...OPUS_CLAUDE },
      jobId: 1,
      jobKey: "k",
      delivery: "d",
      jobKind: "implement",
    });
    // Moved head: PR now at head2, expected head1.
    await withWorkspace(async (workspace) => {
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        expectedHeadSha: "head1",
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head2" }) }) }),
        chain: chain(),
        independentReview: policy(),
        provenance: store,
        forgeKind: "gitea",
        engine: async () => {
          throw new Error("must not run on moved head");
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "PR head changed from head1 to head2" });
    });
    // Reclaimed: same exact head twice selects the same reviewer.
    for (let i = 0; i < 2; i++) {
      await withWorkspace(async (workspace) => {
        const seen: string[] = [];
        const result = await reviewPullRequest({
          ...baseOptions,
          workspace,
          gitRunner: frozenGit("head1"),
          api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
          chain: chain(),
          independentReview: policy(),
          provenance: store,
          forgeKind: "gitea",
          engine: async (opts) => {
            seen.push(opts.model);
            await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
            return { status: "ok", runner: { type: opts.type ?? "opencode", model: opts.model } };
          },
        });
        expect(result).toEqual({ status: "posted" });
        expect(seen).toEqual(["xai/grok-4.6"]);
      });
    }
  });

  test("opt-out preserves behavior without provenance", async () => {
    await withWorkspace(async (workspace) => {
      const seen: string[] = [];
      const result = await reviewPullRequest({
        ...baseOptions,
        workspace,
        gitRunner: frozenGit("head1"),
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ ref: "feature", sha: "head1" }) }) }),
        engine: async (opts) => {
          seen.push(opts.model);
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
      expect(seen).toEqual(["openai/gpt-5.5"]);
    });
  });
});
