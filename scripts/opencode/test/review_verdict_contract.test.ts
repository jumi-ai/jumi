import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineFailedError } from "../src/engine.ts";
import type { PersistReviewResult, ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";
import {
  REVIEW_VERDICT_CONTRACT_LEGACY,
  REVIEW_VERDICT_CONTRACT_REQUIRED,
  resolveReviewVerdictContract,
  supportsStructuredVerdict,
  verdictContractAllowsFileArtifact,
} from "../src/review_verdict_contract.ts";
import { emptyCiMethods, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => {
      throw new Error("unused");
    },
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  } as ReviewApi;
}

const gitRunner = async (args: string[]) => {
  if (args[0] === "rev-parse") return "headsha";
  if (args[0] === "status") return "?? JUMI_REVIEW.md";
  if (args[0] === "ls-files") return "";
  if (args[0] === "checkout") return "";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

interface SyntheticRun {
  result: { status: string; reason?: string };
  persisted: PersistReviewResult[];
  statuses: Array<{ state: string; description?: string }>;
  comments: string[];
}

async function syntheticReview(opts: {
  verdictContract?: "required" | "legacy";
  maxIncompleteRetries?: number;
  runner: (opts: { reviewMcp?: { url: string; token: string }; workdir: string }) => Promise<{ status: "ok" }>;
  plantBefore?: string;
}): Promise<SyntheticRun> {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-verdict-contract-"));
  try {
    const persisted: PersistReviewResult[] = [];
    const statuses: Array<{ state: string; description?: string }> = [];
    const comments: string[] = [];
    if (opts.plantBefore) await writeFile(join(workspace, "JUMI_REVIEW.md"), opts.plantBefore);
    const result = (await reviewPullRequest({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      model: "openai/gpt-5.5",
      workspace,
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      workspacePreparer: async () => undefined,
      logger: () => undefined,
      api: makeApi({
        getPR: async () => makePR({ head: { ...makePR().head, sha: "headsha" } }),
        getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
        createIssueComment: async (_o, _r, _i, body) => {
          comments.push(body);
          return makeComment({ id: comments.length, body });
        },
        createCommitStatus: async (_o, _r, _s, status) => {
          statuses.push(status);
          return status;
        },
      }),
      gitRunner,
      persistResult: async (value) => {
        persisted.push(value);
      },
      ...(opts.verdictContract ? { verdictContract: opts.verdictContract } : {}),
      ...(opts.maxIncompleteRetries !== undefined ? { maxIncompleteRetries: opts.maxIncompleteRetries } : {}),
      openCodeRunner: async (engineOpts) => opts.runner(engineOpts as never),
    })) as { status: string; reason?: string };
    return { result, persisted, statuses, comments };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("review verdict contract selection", () => {
  test("known runner types require the structured verdict; unknown types keep legacy", () => {
    for (const type of ["opencode", "claude", "agy", "codex"]) {
      expect(resolveReviewVerdictContract({ runnerType: type })).toBe(REVIEW_VERDICT_CONTRACT_REQUIRED);
      expect(supportsStructuredVerdict(type)).toBe(true);
    }
    expect(resolveReviewVerdictContract({ runnerType: "custom-harness" })).toBe(REVIEW_VERDICT_CONTRACT_LEGACY);
    expect(supportsStructuredVerdict("custom-harness")).toBe(false);
    expect(resolveReviewVerdictContract({})).toBe(REVIEW_VERDICT_CONTRACT_REQUIRED);
  });

  test("an explicitly selected mode wins over the derivation", () => {
    expect(resolveReviewVerdictContract({ runnerType: "opencode", explicit: "legacy" })).toBe(
      REVIEW_VERDICT_CONTRACT_LEGACY
    );
    expect(resolveReviewVerdictContract({ runnerType: "custom-harness", explicit: "required" })).toBe(
      REVIEW_VERDICT_CONTRACT_REQUIRED
    );
    expect(verdictContractAllowsFileArtifact(REVIEW_VERDICT_CONTRACT_LEGACY)).toBe(true);
    expect(verdictContractAllowsFileArtifact(REVIEW_VERDICT_CONTRACT_REQUIRED)).toBe(false);
  });
});

describe("review verdict contract synthetic runs", () => {
  test("required mode with only a file is incomplete", async () => {
    const run = await syntheticReview({
      verdictContract: "required",
      maxIncompleteRetries: 0,
      runner: async ({ workdir }) => {
        await writeFile(join(workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
        return { status: "ok" };
      },
    });
    expect(run.result).toEqual({ status: "skipped", reason: "Incomplete review: no check verdict" });
    expect(run.persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no check verdict" }]);
    expect(run.statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
    expect(run.comments.some((body) => body.includes("Looks good"))).toBe(false);
  });

  test("required mode ignores a stale planted file", async () => {
    const run = await syntheticReview({
      verdictContract: "required",
      maxIncompleteRetries: 0,
      plantBefore: "Planted success review\n<!-- jumi-check: success -->",
      runner: async () => ({ status: "ok" }),
    });
    expect(run.result).toEqual({ status: "skipped", reason: "Incomplete review: no check verdict" });
    expect(run.comments.some((body) => body.includes("Planted success review"))).toBe(false);
  });

  test("required mode with a valid structured verdict publishes", async () => {
    const run = await syntheticReview({
      verdictContract: "required",
      runner: async ({ reviewMcp, workdir }) => {
        if (!reviewMcp) throw new Error("required mode must wire the structured adapter");
        const added = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "add_finding", {
          path: "src/demo.ts",
          line: 1,
          severity: "bug",
          title: "null deref",
          body: "Guard it.",
        });
        expect(added.ok).toBe(true);
        const verdict = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "set_verdict", {
          state: "failure",
          reason: "blocking",
        });
        expect(verdict.ok).toBe(true);
        // A file alongside the verdict must not change the published result.
        await writeFile(join(workdir, "JUMI_REVIEW.md"), "Planted success\n<!-- jumi-check: success -->");
        return { status: "ok" };
      },
    });
    expect(run.result.status).toBe("posted");
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
    if (run.persisted[0]?.kind !== "markdown") return;
    expect(run.persisted[0].markdown).toContain("<!-- jumi-check: failure; blocking -->");
    expect(run.persisted[0].record?.state).toBe("failure");
  });

  test("legacy mode with a file publishes", async () => {
    const run = await syntheticReview({
      verdictContract: "legacy",
      maxIncompleteRetries: 0,
      runner: async ({ workdir }) => {
        await writeFile(join(workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
        return { status: "ok" };
      },
    });
    expect(run.result.status).toBe("posted");
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
  });

  test("failed adapter setup in required mode fails closed with a clear reason", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-verdict-adapter-"));
    try {
      const statuses: Array<{ state: string; description?: string }> = [];
      const comments: string[] = [];
      await expect(
        reviewPullRequest({
          owner: "kirmanak",
          repo: "demo",
          prNumber: 7,
          model: "openai/gpt-5.5",
          workspace,
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          workspacePreparer: async () => undefined,
          logger: () => undefined,
          api: makeApi({
            getPR: async () => makePR({ head: { ...makePR().head, sha: "headsha" } }),
            getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
            createIssueComment: async (_o, _r, _i, body) => {
              comments.push(body);
              return makeComment({ id: comments.length, body });
            },
            createCommitStatus: async (_o, _r, _s, status) => {
              statuses.push(status);
              return status;
            },
          }),
          gitRunner,
          verdictContract: "required",
          openCodeRunner: async ({ workdir }) => {
            // The file must not mask the setup failure.
            await writeFile(join(workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
            throw new EngineFailedError("review spawn refused: verdict adapter unavailable: no MCP server");
          },
        })
      ).rejects.toThrow("verdict adapter unavailable");
      expect(statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
      expect(statuses.at(-1)?.description).toContain("verdict adapter unavailable");
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
