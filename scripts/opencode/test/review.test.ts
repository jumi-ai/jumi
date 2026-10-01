import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { providerAuthDeathMessage } from "../src/auth.ts";
import { CI_ABSENT_REASON, CI_FAILED_REASON, CI_LOOKUP_FAILED_REASON, CI_PENDING_REASON } from "../src/ci.ts";
import { reviewStuckStatePath } from "../src/claim.ts";
import { isJumiReviewFinding } from "../src/followup.ts";
import { GithubAPI } from "../src/github_api.ts";
import type { PersistReviewResult, ReviewApi } from "../src/review.ts";
import {
  applyContractEnvGate,
  INCOMPLETE_REVIEW_STUCK,
  MAX_INCOMPLETE_RETRIES,
  publishReviewResult,
  reviewPullRequest,
} from "../src/review.ts";
import { fingerprintReviewArtifact, readStuckState, stuckMarker, writeStuckState } from "../src/stuck.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeBranch,
  makeComment,
  makeFile,
  makeIssue,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
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
  };
  return { ...defaults, ...overrides };
}

const skipOptions = {
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

function frozenGit(opts: { head?: string; porcelain?: string } = {}): GitRunner {
  const head = opts.head ?? "headsha";
  const porcelain = opts.porcelain ?? "?? JUMI_REVIEW.md";
  return async (args) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return porcelain;
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-review-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeReview(workspace: string, contents: string) {
  await writeFile(join(workspace, "JUMI_REVIEW.md"), contents);
}

function reviewOptions(workspace: string, gitRunner: GitRunner = frozenGit()) {
  return { ...skipOptions, workspace, gitRunner };
}

const REVIEW_SHA = "d90b7289701097dae3ffa3dc0ccdc348be552697";

function reviewWriteup(
  prose: string,
  checkLine: string,
  sha = "headsha",
  marker = "<!-- jumi-review:kirmanak/demo#7 -->"
): string {
  const body = `${marker}\n### Jumi review\n\nReviewed commit: \`${sha}\`\n\n${prose}`;
  if (!checkLine) return body;
  return `${body.trimEnd()}\n\n${checkLine}`;
}

const DEFAULT_RUNNER_STAMP = "_Jumi · opencode · openai/gpt-5.5_";

function stampedWriteup(prose: string, checkLine: string, sha = "headsha"): string {
  return reviewWriteup(`${prose.trim()}\n\n${DEFAULT_RUNNER_STAMP}`.trim(), checkLine, sha);
}

function reviewOptionsWithSha(workspace: string, sha = REVIEW_SHA) {
  return {
    ...skipOptions,
    workspace,
    gitRunner: frozenGit({ head: sha }),
  };
}

describe("reviewPullRequest", () => {
  test("skips closed, merged, and WIP PRs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ state: "closed" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is closed" });
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ merged: true }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is already merged" });
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ title: "WIP: no" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR title disables review" });
  });

  test("skips pending or failed non-jumi checks without OpenCode or status", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };
    const statuses: Array<{ state: string }> = [];
    const pendingApi = makeApi({
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "pending" }],
      createCommitStatus: async (_owner, _repo, _sha, status) => {
        statuses.push(status);
        return status;
      },
    });
    await expect(reviewPullRequest({ ...skipOptions, api: pendingApi, openCodeRunner: runner })).resolves.toEqual({
      status: "skipped",
      reason: CI_PENDING_REASON,
    });
    expect(statuses).toEqual([]);

    const failedStatuses: Array<{ state: string }> = [];
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            failedStatuses.push(status);
            return status;
          },
        }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: CI_FAILED_REASON });
    expect(failedStatuses).toEqual([]);

    const liveFailedStatuses: Array<{ state: string }> = [];
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "failure" },
          ],
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            liveFailedStatuses.push(status);
            return status;
          },
        }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: CI_FAILED_REASON });
    expect(liveFailedStatuses).toEqual([]);
  });

  test("re-lists once when no other checks have appeared yet", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };
    let looks = 0;
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        listCommitStatuses: async () => [],
        listCheckRuns: async () => [],
        listActionJobs: async () => {
          looks++;
          if (looks === 1) return [];
          return [{ id: 9, name: "build", head_sha: "headsha", status: "in_progress" }];
        },
      }),
      openCodeRunner: runner,
    });
    expect(result).toEqual({ status: "skipped", reason: CI_PENDING_REASON });
    expect(looks).toBe(2);
  });

  test("skips instead of reviewing when a CI lookup fails", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };
    let looks = 0;
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        listActionJobs: async () => {
          looks++;
          throw new Error("rate limited");
        },
      }),
      openCodeRunner: runner,
    });
    expect(result).toEqual({ status: "skipped", reason: CI_LOOKUP_FAILED_REASON });
    expect(looks).toBe(2);
  });

  test("re-lists when the first CI lookup fails", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };
    let looks = 0;
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        listActionJobs: async () => {
          looks++;
          if (looks === 1) throw new Error("rate limited");
          return [{ id: 9, name: "build", head_sha: "headsha", status: "in_progress" }];
        },
      }),
      openCodeRunner: runner,
    });
    expect(result).toEqual({ status: "skipped", reason: CI_PENDING_REASON });
    expect(looks).toBe(2);
  });

  test("partial list failure is not green and is not no CI", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
        listActionJobs: async () => {
          throw new Error("rate limited");
        },
      }),
      openCodeRunner: runner,
    });
    expect(result).toEqual({ status: "skipped", reason: CI_LOOKUP_FAILED_REASON });
  });

  test("does not review when no checks have appeared", async () => {
    let looks = 0;
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        listCommitStatuses: async () => [],
        listCheckRuns: async () => [],
        listActionJobs: async () => {
          looks++;
          return [];
        },
      }),
      openCodeRunner: async () => {
        throw new Error("runner should not be called");
      },
    });
    expect(result).toEqual({ status: "skipped", reason: CI_ABSENT_REASON });
    expect(looks).toBe(2);
  });

  test("reviews PRs titled [skip review]", async () => {
    await withWorkspace(async (workspace) => {
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ title: "Add thing [skip review]", head: makeBranch({ sha: REVIEW_SHA }) }),
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
    });
  });

  test("stuck repeated finding skips OpenCode without failing jumi/opencode-review", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-review-stuck-"));
    try {
      const hash = fingerprintReviewArtifact("please fix the tests\n<!-- jumi-check: failure -->")!;
      await writeStuckState(reviewStuckStatePath(home, "kirmanak", "demo", 7), {
        fingerprints: [
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const statuses: Array<{ state: string; context?: string }> = [];
      const comments: string[] = [];
      let openCode = 0;
      const result = await reviewPullRequest({
        ...skipOptions,
        home,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: 1, body });
          },
        }),
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
      expect(openCode).toBe(0);
      expect(statuses.some((status) => status.state === "failure")).toBe(false);
      expect(comments.at(-1)).toContain("stuck: repeated action");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("records a review finding fingerprint after a failure artifact", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-review-fp-"));
    try {
      await withWorkspace(async (workspace) => {
        await reviewPullRequest({
          ...reviewOptions(workspace),
          home,
          api: makeApi(),
          openCodeRunner: async () => {
            await writeReview(workspace, "please fix the tests\n<!-- jumi-check: failure -->");
            return { status: "ok" };
          },
        });
        const state = await readStuckState(reviewStuckStatePath(home, "kirmanak", "demo", 7));
        expect(state.fingerprints).toEqual([
          {
            kind: "action",
            hash: fingerprintReviewArtifact("please fix the tests\n<!-- jumi-check: failure -->")!,
          },
        ]);
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("posts the pull-review writeup from JUMI_REVIEW.md, not OpenCode stdout", async () => {
    await withWorkspace(async (workspace) => {
      const reviews: unknown[] = [];
      let sticky = "";
      const statuses: Array<{
        sha: string;
        state: string;
        context?: string;
        description?: string;
        target_url?: string;
      }> = [];
      const persisted: PersistReviewResult[] = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            sticky = body;
            return makeComment({ id: 123, body });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
          createCommitStatus: async (_owner, _repo, sha, status) => {
            statuses.push({ sha, ...status });
            return status;
          },
        }),
        persistResult: async (value) => {
          persisted.push(value);
        },
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(result).toEqual({ status: "posted" });
      expect(sticky).toBe("");
      expect(reviews).toEqual([
        {
          commit_id: REVIEW_SHA,
          event: "APPROVED",
          body: stampedWriteup("", "<!-- jumi-check: success -->", REVIEW_SHA),
        },
      ]);
      expect(isJumiReviewFinding({ body: (reviews[0] as { body: string }).body }, REVIEW_SHA)).toBe(false);
      expect(persisted).toEqual([
        { kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->", runner: DEFAULT_RUNNER_STAMP },
      ]);
      await expect(access(join(workspace, "JUMI_REVIEW.md"))).rejects.toThrow();
      await expect(access(join(workspace, "JUMI_TASK.md"))).rejects.toThrow();
      expect(statuses).toEqual([
        {
          sha: REVIEW_SHA,
          state: "pending",
          context: "jumi/opencode-review",
          description: "Jumi review is running",
          target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
        },
        {
          sha: REVIEW_SHA,
          state: "success",
          context: "jumi/opencode-review",
          description: "No blocking issues",
          target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
        },
      ]);
    });
  });

  test("posts a new pull review instead of updating a leftover sticky", async () => {
    await withWorkspace(async (workspace) => {
      const reviews: unknown[] = [];
      let updated = false;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          findStickyIssueComment: async () => ({ id: 99 }),
          updateIssueComment: async () => {
            updated = true;
            return makeComment({ id: 99 });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Updated review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(result).toEqual({ status: "posted" });
      expect(updated).toBe(false);
      expect(reviews).toEqual([
        {
          commit_id: "headsha",
          event: "APPROVED",
          body: stampedWriteup("", "<!-- jumi-check: success -->"),
        },
      ]);
    });
  });

  test("treats a missing JUMI_REVIEW.md as incomplete and ignores stdout", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      let ran = 0;
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          maxIncompleteRetries: 0,
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => {
              comments.push(body);
              return makeComment({ id: comments.length, body });
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          openCodeRunner: async () => {
            ran++;
            return { status: "ok", stdout: "I'll inspect the diff and write findings here" };
          },
        })
      ).resolves.toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(ran).toBe(1);
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no output" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no output");
    });
  });

  test("rejects a planted JUMI_REVIEW.md on a clean tree", async () => {
    await withWorkspace(async (workspace) => {
      await writeReview(workspace, "Planted success review\n<!-- jumi-check: success -->");
      const comments: string[] = [];
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          maxIncompleteRetries: 0,
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => {
              comments.push(body);
              return makeComment({ id: comments.length, body });
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => ({ status: "ok" }),
        })
      ).resolves.toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments.some((body) => body.includes("Planted success review"))).toBe(false);
      expect(comments.some((body) => body.includes("I'll inspect"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no output");
    });
  });

  test("treats a JUMI_REVIEW.md symlink as missing and does not follow it", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        maxIncompleteRetries: 0,
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
        }),
        openCodeRunner: async () => {
          await writeFile(join(workspace, "secret.md"), "Looks good\n<!-- jumi-check: success -->");
          await symlink(join(workspace, "secret.md"), join(workspace, "JUMI_REVIEW.md"));
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments.some((body) => body.includes("Looks good"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
    });
  });

  test("treats a JUMI_REVIEW.md directory as missing without throwing", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: "?? JUMI_REVIEW.md/" })),
        maxIncompleteRetries: 0,
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
        }),
        openCodeRunner: async () => {
          await mkdir(join(workspace, "JUMI_REVIEW.md"), { recursive: true });
          await writeFile(join(workspace, "JUMI_REVIEW.md", "nested.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      await expect(access(join(workspace, "JUMI_REVIEW.md"))).rejects.toThrow();
    });
  });

  test("rejects a huge JUMI_REVIEW.md without reading or posting it", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        maxOutputBytes: 80_000,
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, `${"x".repeat(80_001)}\n<!-- jumi-check: success -->`);
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: output too large" });
      expect(created).toBe(false);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: output too large");
    });
  });

  test("treats an empty JUMI_REVIEW.md as incomplete", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        maxIncompleteRetries: 0,
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "  \n");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });
    });
  });

  test("retries OpenCode when the first run writes no artifact", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      let ran = 0;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
        }),
        openCodeRunner: async () => {
          ran++;
          if (ran < 2) return { status: "ok", stdout: "I'll inspect and dump the review here" };
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(2);
      expect(result).toEqual({ status: "posted" });
      expect(comments).toHaveLength(0);
    });
  });

  test("posts stuck after capped incomplete retries and does not enqueue a review sticky", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      const persisted: PersistReviewResult[] = [];
      let ran = 0;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
        }),
        persistResult: async (value) => {
          persisted.push(value);
        },
        openCodeRunner: async () => {
          ran++;
          return { status: "ok", stdout: "chat dump of a review that never wrote the file" };
        },
      });
      expect(ran).toBe(1 + MAX_INCOMPLETE_RETRIES);
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no output" }]);
      expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
      expect(comments.some((body) => body.includes("unassign"))).toBe(false);
      expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
    });
  });

  test("incomplete retry cap sticks at configured maxIncompleteRetries, not only 2", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
        maxIncompleteRetries: 1,
        api: makeApi(),
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      });
      expect(ran).toBe(2);
    });
  });

  test("incomplete extras resume an agy conversation id with a write-only prompt", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi(),
        openCodeRunner: async (opts) => {
          ran++;
          const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          if (ran === 1) {
            expect(opts.continueSession).toBeFalsy();
            await mkdir(join(workspace, ".jumi-tmp"), { recursive: true });
            await writeFile(join(workspace, ".jumi-tmp", "agy-conversation-id"), "conv-123\n");
            return { status: "ok", stdout: "I'll inspect and dump the review here" };
          }
          expect(opts.continueSession).toBe(true);
          expect(task).toContain("Write JUMI_REVIEW.md");
          expect(task).not.toContain("I'll inspect");
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(2);
      expect(result).toEqual({ status: "posted" });
    });
  });

  test("incomplete extras keep the session DB and continue with a write-only prompt", async () => {
    await withWorkspace(async (workspace) => {
      const comments: string[] = [];
      let ran = 0;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            comments.push(body);
            return makeComment({ id: comments.length, body });
          },
        }),
        openCodeRunner: async (opts) => {
          ran++;
          const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          if (ran === 1) {
            expect(opts.continueSession).toBeFalsy();
            expect(task).toContain("Review the pull request above");
            await mkdir(join(workspace, ".jumi-tmp"), { recursive: true });
            await writeFile(join(workspace, ".jumi-tmp", "opencode-session.db"), "db");
            return { status: "ok", stdout: "I'll inspect and dump the review here" };
          }
          expect(opts.continueSession).toBe(true);
          expect(task).toContain("Write JUMI_REVIEW.md");
          expect(task).toContain("write tool");
          expect(task).toContain("already in this session");
          expect(task).not.toContain("Review the pull request above");
          expect(task).not.toContain("I'll inspect");
          expect("prompt" in opts).toBe(false);
          await access(join(workspace, ".jumi-tmp", "opencode-session.db"));
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(2);
      expect(result).toEqual({ status: "posted" });
      expect(comments).toHaveLength(0);
    });
  });

  test("incomplete extras without a session inject last assistant text into a write-only run", async () => {
    await withWorkspace(async (workspace) => {
      let ran = 0;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi(),
        openCodeRunner: async (opts) => {
          ran++;
          const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          if (ran === 1) {
            expect(opts.continueSession).toBeFalsy();
            expect(task).toContain("Review the pull request above");
            return { status: "ok", stdout: "file.ts:1: 🟡 risk: missing null check." };
          }
          expect(opts.continueSession).toBeFalsy();
          expect(task).toContain("Write JUMI_REVIEW.md");
          expect(task).toContain("file.ts:1: 🟡 risk: missing null check.");
          expect(task).toContain("input to the write tool, not the sticky");
          expect(task).not.toContain("Review the pull request above");
          await writeReview(workspace, "file.ts:1: 🟡 risk: missing null check.\n<!-- jumi-check: failure -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(2);
      expect(result).toEqual({ status: "posted" });
    });
  });

  test("provider-unavailable primary hops once to the fallback model from scratch", async () => {
    await withWorkspace(async (workspace) => {
      const calls: Array<{ model: string; continueSession?: boolean; hop?: boolean }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        fallbackModel: "anthropic/claude-sonnet-4-6",
        api: makeApi(),
        openCodeRunner: async (opts) => {
          calls.push({ model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
          if (opts.model === "openai/gpt-5.5") {
            return { status: "exit", exitCode: 1, message: "opencode exited with code 1:\n429 rate limit exceeded" };
          }
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
      expect(calls).toEqual([
        { model: "openai/gpt-5.5", continueSession: undefined, hop: undefined },
        { model: "anthropic/claude-sonnet-4-6", continueSession: false, hop: true },
      ]);
    });
  });

  test("incomplete extras after a fallback hop continue that fallback session", async () => {
    await withWorkspace(async (workspace) => {
      const calls: Array<{ model: string; continueSession?: boolean; hop?: boolean }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        fallbackModel: "anthropic/claude-sonnet-4-6",
        api: makeApi(),
        openCodeRunner: async (opts) => {
          calls.push({ model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
          if (opts.model === "openai/gpt-5.5") {
            await mkdir(join(workspace, ".jumi-tmp"), { recursive: true });
            await writeFile(join(workspace, ".jumi-tmp", "opencode-session.db"), "primary");
            return { status: "exit", exitCode: 1, message: "model not found" };
          }
          if (!opts.continueSession) {
            await mkdir(join(workspace, ".jumi-tmp"), { recursive: true });
            await writeFile(join(workspace, ".jumi-tmp", "opencode-session.db"), "fallback");
            return { status: "ok", stdout: "chat dump" };
          }
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
      expect(calls).toEqual([
        { model: "openai/gpt-5.5", continueSession: undefined, hop: undefined },
        { model: "anthropic/claude-sonnet-4-6", continueSession: false, hop: true },
        { model: "anthropic/claude-sonnet-4-6", continueSession: true, hop: undefined },
      ]);
    });
  });

  test("does not treat .jumi-tmp leftovers as a dirty review tree", async () => {
    await withWorkspace(async (workspace) => {
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: "?? .jumi-tmp/\n?? JUMI_REVIEW.md" })),
        api: makeApi(),
        openCodeRunner: async () => {
          await mkdir(join(workspace, ".jumi-tmp"), { recursive: true });
          await writeFile(join(workspace, ".jumi-tmp", "opencode-session.db"), "db");
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
    });
  });

  test("keeps a failure trailer on the pull-review body for worker follow-up", async () => {
    await withWorkspace(async (workspace) => {
      const reviews: Array<{ body?: string }> = [];
      let sticky = "";
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            sticky = body;
            return makeComment({ id: 44, body });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(
            workspace,
            "L12: 🔴 bug: null deref. Guard it.\nL40: 🟡 risk: swallowed error. Fail closed.\n<!-- jumi-check: failure; 2 blocking -->"
          );
          return { status: "ok" };
        },
      });

      expect(result.status).toBe("posted");
      expect(sticky).toBe("");
      expect(reviews[0]?.body).not.toContain("L12:");
      expect(reviews[0]?.body).not.toContain("I'll inspect");
      expect(lastNonEmptyLine(reviews[0]?.body ?? "")).toBe("<!-- jumi-check: failure; 2 blocking -->");
      expect(isJumiReviewFinding({ body: reviews[0]?.body }, REVIEW_SHA)).toBe(true);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("2 blocking");
    });
  });

  test("fails closed when JUMI_REVIEW.md omits the check trailer", async () => {
    await withWorkspace(async (workspace) => {
      let createdBody = "";
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            createdBody = body;
            return makeComment({ id: 44, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "No correctness bugs found.");
          return { status: "ok" };
        },
      });

      expect(result).toEqual({ status: "posted", commentId: 44 });
      expect(createdBody).not.toContain("No correctness bugs found.");
      expect(createdBody).not.toContain("I'll inspect");
      expect(createdBody).not.toContain("jumi-check");
      expect(isJumiReviewFinding({ body: createdBody }, REVIEW_SHA)).toBe(false);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no check verdict");
    });
  });

  test("does not treat a #136-shaped sticky without a trailer as a finding", () => {
    const body = [
      "<!-- jumi-review:personal/jumi#136 -->",
      "### Jumi review",
      "",
      "Reviewed commit: `d90b7289701097dae3ffa3dc0ccdc348be552697`",
      "",
      "L12: 🔴 bug: null deref. Guard it.",
      "L40: 🔴 bug: swallowed error. Fail closed.",
    ].join("\n");
    expect(isJumiReviewFinding({ body }, "d90b7289701097dae3ffa3dc0ccdc348be552697")).toBe(false);
  });

  test("keeps a questions-only review green when the artifact reports success", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(
            workspace,
            "No correctness bugs.\n❓ q: is the timeout intentional?\n<!-- jumi-check: success -->"
          );
          return { status: "ok" };
        },
      });
      expect(statuses.at(-1)).toMatchObject({ state: "success", description: "No blocking issues" });
    });
  });

  test("inlines 💡 findings without flipping a success trailer", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const reviews: unknown[] = [];
      let sticky = "";
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            sticky = body;
            return makeComment({ id: 44, body });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: 1 };
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "src/demo.ts:8: 💡 simpler: drop the helper.\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result.status).toBe("posted");
      expect(sticky).toBe("");
      expect(statuses.at(-1)).toMatchObject({ state: "success", description: "No blocking issues" });
      expect(reviews).toEqual([
        {
          commit_id: "headsha",
          event: "APPROVED",
          body: stampedWriteup("", "<!-- jumi-check: success -->"),
          comments: [
            {
              path: "src/demo.ts",
              new_position: 8,
              body: "💡 simpler: drop the helper.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
            },
          ],
        },
      ]);
    });
  });

  test("marks the review incomplete when HEAD moved", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ head: "other sha" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: HEAD moved" });
      expect(created).toBe(false);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: HEAD moved" });
    });
  });

  test("marks the review incomplete when extra files are dirty", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: " M src/demo.ts\n?? JUMI_REVIEW.md" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: dirty tree" });
      expect(created).toBe(false);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: dirty tree" });
    });
  });

  test("restores a tracked JUMI_TASK.md after the engine instead of deleting it", async () => {
    await withWorkspace(async (workspace) => {
      const original = "# original task from the PR\n";
      await writeFile(join(workspace, "JUMI_TASK.md"), original);
      const gitRunner: GitRunner = async (args) => {
        if (args[0] === "ls-files") return args.includes("JUMI_TASK.md") ? "JUMI_TASK.md" : "";
        if (args[0] === "checkout" && args.includes("JUMI_TASK.md")) {
          await writeFile(join(workspace, "JUMI_TASK.md"), original);
          return "";
        }
        if (args[0] === "rev-parse") return "headsha";
        if (args[0] === "status") return "?? JUMI_REVIEW.md";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      let engineSaw = "";
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, gitRunner),
        api: makeApi(),
        openCodeRunner: async () => {
          engineSaw = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result.status).toBe("posted");
      expect(engineSaw).toContain("Write JUMI_REVIEW.md");
      expect(await readFile(join(workspace, "JUMI_TASK.md"), "utf8")).toBe(original);
    });
  });

  test("without persist, posts failure status when sticky write fails after a good review", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createPullReview: async () => {
              throw new Error("review write failed");
            },
            createIssueComment: async () => {
              throw new Error("sticky write failed");
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return { status: "ok" };
          },
        })
      ).rejects.toThrow("sticky write failed");
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Jumi review failed: sticky write failed");
    });
  });

  test("engine does not overwrite pending after persist when publish throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createPullReview: async () => {
              throw new Error("review write failed");
            },
            createIssueComment: async () => {
              throw new Error("sticky write failed");
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return { status: "ok" };
          },
        })
      ).rejects.toThrow("sticky write failed");
      expect(persisted).toEqual([
        { kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->", runner: DEFAULT_RUNNER_STAMP },
      ]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("does not persist error or post failure when markdown persist throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
            throw new Error("cannot save result");
          },
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return { status: "ok" };
          },
        })
      ).rejects.toThrow("cannot save result");
      expect(persisted).toEqual([
        { kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->", runner: DEFAULT_RUNNER_STAMP },
      ]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("does not persist error or post failure when skip persist throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
            throw new Error("cannot save result");
          },
          openCodeRunner: async () => ({ status: "ok" }),
        })
      ).rejects.toThrow("cannot save result");
      expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no output" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("without persist, posts failure status when skip status write fails", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              if (status.state === "failure") throw new Error("status write failed");
              return status;
            },
          }),
          openCodeRunner: async () => ({ status: "ok" }),
        })
      ).rejects.toThrow("status write failed");
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure", "failure"]);
      expect(statuses[2].description).toBe("Jumi review failed: status write failed");
    });
  });

  test("interrupt does not persist an error or post a sticky", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      const abort = new AbortController();
      const err = new Error("cancelled");
      err.name = "AbortError";
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
            createIssueComment: async () => {
              throw new Error("should not post sticky");
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          abortSignal: abort.signal,
          openCodeRunner: async () => {
            abort.abort();
            throw err;
          },
        })
      ).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });

      expect(persisted).toEqual([]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("marks the commit status failed when the review crashes", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => {
            throw new Error("model unavailable");
          },
        })
      ).rejects.toThrow("model unavailable");

      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Jumi review failed: model unavailable");
    });
  });

  test("auth death posts a short hostname status, not OpenCode stderr", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const grant = `opencode exited with code 1:\n${"x".repeat(400)} invalid_grant refresh token revoked`;
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => ({
            status: "exit",
            exitCode: 1,
            auth: true,
            message: providerAuthDeathMessage(),
          }),
        })
      ).rejects.toMatchObject({ auth: true, message: providerAuthDeathMessage() });

      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe(`Jumi review failed: ${providerAuthDeathMessage()}`);
      expect(statuses[1].description).toContain(hostname());
      expect(statuses[1].description).toContain("auth");
      expect(statuses[1].description).not.toContain("invalid_grant");
      expect(statuses[1].description).not.toContain(grant);
      expect(new TextEncoder().encode(statuses[1].description ?? "").byteLength).toBeLessThan(140);
    });
  });

  test("truncates long status descriptions without splitting UTF-8 characters", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const message = "€".repeat(200);
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => {
            throw new Error(message);
          },
        })
      ).rejects.toThrow(message);

      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description?.endsWith("…")).toBe(true);
      expect(new TextEncoder().encode(statuses[1].description ?? "").byteLength).toBeLessThanOrEqual(255);
      expect(Array.from(statuses[1].description ?? "").length).toBeLessThanOrEqual(140);
    });
  });

  test("posts a short failure status without OpenCode stderr", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      const stderr = `tool trace ${"x".repeat(400)}`;
      const message = `opencode exited with code 143:\n${stderr}`;
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          openCodeRunner: async () => {
            throw new Error(message);
          },
        })
      ).rejects.toThrow(message);

      expect(persisted).toEqual([{ kind: "error", error: `Jumi review failed: ${message}` }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe(`Jumi review failed: ${hostname()}: opencode exited with code 143`);
      expect(statuses[1].description).toContain(hostname());
      expect(statuses[1].description).not.toContain(stderr);
      expect(statuses[1].description).not.toContain("tool trace");
      expect(Array.from(statuses[1].description ?? "").length).toBeLessThanOrEqual(140);
    });
  });

  test("GitHub status POST stays within 140 characters and still publishes a produced review", async () => {
    await withWorkspace(async (workspace) => {
      const bodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return Response.json({ state: "failure", context: "jumi/opencode-review" });
      }) as unknown as typeof fetch;
      const reviews: unknown[] = [];
      const github = new GithubAPI({ token: "token" });
      try {
        const reason = "blocking ".repeat(30);
        await reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createPullReview: async (_owner, _repo, _index, review) => {
              reviews.push(review);
              return { id: 1 };
            },
            createCommitStatus: (owner, repo, sha, status) => github.createCommitStatus(owner, repo, sha, status),
          }),
          openCodeRunner: async () => {
            await writeReview(workspace, `note\n<!-- jumi-check: failure; ${reason} -->`);
            return { status: "ok" };
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(reviews).toHaveLength(1);
      const posted = bodies.map((body) => JSON.parse(body) as { state?: string; description?: string });
      expect(posted.some((status) => status.state === "pending")).toBe(true);
      const failure = posted.find((status) => status.state === "failure");
      expect(failure?.description?.endsWith("…")).toBe(true);
      expect(Array.from(failure?.description ?? "").length).toBeLessThanOrEqual(140);
      expect(failure?.description).not.toBe("blocking ".repeat(30));
    });
  });

  test("skips stale jobs before OpenCode runs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ sha: "newsha" }) }) }),
        expectedHeadSha: "oldsha",
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
  });

  test("skips posting when the PR head changes during review", async () => {
    await withWorkspace(async (workspace) => {
      let getPRCalls = 0;
      let stickyLookup = false;
      let created = false;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPR: async () => {
            getPRCalls++;
            return makePR({ head: makeBranch({ sha: getPRCalls === 1 ? "oldsha" : "newsha" }) });
          },
          findStickyIssueComment: async () => {
            stickyLookup = true;
            return undefined;
          },
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ body });
          },
        }),
        expectedHeadSha: "oldsha",
        openCodeRunner: async () => ({ status: "ok" }),
      });

      expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
      expect(getPRCalls).toBe(2);
      expect(stickyLookup).toBe(false);
      expect(created).toBe(false);
    });
  });

  test("checks out the repository before running OpenCode and tells it the target branch", async () => {
    await withWorkspace(async (workspace) => {
      let checkout: unknown;
      let prompt = "";
      let runnerWorkdir = "";

      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({ getPR: async () => makePR({ base: makeBranch({ ref: "main", sha: "basesha" }) }) }),
        workspacePreparer: async (opts) => {
          checkout = {
            workdir: opts.workdir,
            repo: opts.repo.full_name,
            pr: opts.pr.number,
            targetBranch: opts.pr.base.ref,
            headSha: opts.pr.head.sha,
            giteaUrl: opts.giteaUrl,
            username: opts.username,
            token: opts.token,
          };
        },
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          runnerWorkdir = opts.workdir;
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(checkout).toEqual({
        workdir: workspace,
        repo: "kirmanak/demo",
        pr: 7,
        targetBranch: "main",
        headSha: "headsha",
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
      });
      expect(runnerWorkdir).toBe(workspace);
      expect(prompt).toContain('target_branch="main"');
      expect(prompt).toContain('target_ref="jumi/target"');
      expect(prompt).toContain('target_remote_ref="origin/main"');
      expect(prompt).toContain("stable refs like jumi/target and HEAD");
      expect(prompt).toContain("git log --oneline jumi/target..HEAD");
      expect(prompt).toContain("web search/fetch");
    });
  });

  test("parent-injects a matching REVIEW.md path section from the head and posts a Jumi review heading", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      let sticky = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        workspacePreparer: async (opts) => {
          await writeFile(
            join(opts.workdir, "REVIEW.md"),
            "## Security\n\nNever log tokens.\n\n## k3s/**, **/values.yaml\n\nBump checksum/config when a ConfigMap changes.\n\n## *.ts\n\nPrefer Bun APIs.\n"
          );
        },
        api: makeApi({
          getPRFiles: async () => [makeFile({ filename: "k3s/apps/gitea/values.yaml" })],
          createIssueComment: async (_owner, _repo, _index, body) => {
            sticky = body;
            return makeComment({ id: 1, body });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            sticky = review.body ?? "";
            return { id: 1 };
          },
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "No apply explosion.\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain("You are Jumi's reviewer");
      expect(prompt).toContain('<review_md path="REVIEW.md" truncated="false">');
      expect(prompt).toContain("Bump checksum/config when a ConfigMap changes.");
      expect(prompt).toContain("Never log tokens.");
      expect(prompt).not.toContain("Prefer Bun APIs.");
      expect(prompt).not.toContain("gitops-apply-review");
      expect(prompt).not.toContain("Checksum / rollout");
      expect(prompt).not.toContain("House misses");
      expect(prompt).not.toContain("skill tool");
      expect(sticky).toContain("### Jumi review");
      expect(sticky).not.toContain("### Jumi OpenCode review");
    });
  });

  test("leaves out a REVIEW.md path section no changed file matches", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        workspacePreparer: async (opts) => {
          await writeFile(join(opts.workdir, "REVIEW.md"), "## k3s/**\n\nBump checksum/config.\n");
        },
        api: makeApi({ getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })] }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Fine.\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain("You are Jumi's reviewer");
      expect(prompt).not.toContain("Bump checksum/config.");
      expect(prompt).not.toContain("<review_md");
    });
  });

  test("reviews a Helm-path PR without REVIEW.md and no substitute checklist", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      const status: string[] = [];
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPRFiles: async () => [makeFile({ filename: "k3s/apps/gitea/values.yaml" })],
          createCommitStatus: async (_owner, _repo, _sha, s) => {
            status.push(s.state);
            return s;
          },
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Fine.\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain("You are Jumi's reviewer");
      expect(prompt).not.toContain("<review_md");
      expect(prompt).not.toContain("gitops-apply-review");
      expect(prompt).not.toContain("Checksum / rollout");
      expect(status.at(-1)).toBe("success");
    });
  });

  test("adds review notes when file and patch limits are hit", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPRFiles: async () => [
            makeFile({ filename: "first.ts", patch: "abcdef" }),
            makeFile({ filename: "second.ts", patch: "ghijkl" }),
          ],
        }),
        maxFiles: 1,
        maxPatchBytes: 3,
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain("Only the first 1 of 2 changed files are included.");
      expect(prompt).toContain("Patch for first.ts was truncated to fit the patch budget.");
      expect(prompt).toContain("abc\n[patch truncated]");
    });
  });

  test("loads linked issue 12 and PR comments for Fixes #12", async () => {
    const calls: Array<{ method: string; index: number }> = [];
    await withWorkspace(async (workspace) => {
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPR: async () => makePR({ body: "Fixes #12" }),
          getIssue: async (_owner, _repo, index) => {
            calls.push({ method: "getIssue", index });
            return makeIssue({ number: index });
          },
          listIssueComments: async (_owner, _repo, index) => {
            calls.push({ method: "listIssueComments", index });
            return [];
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
    });

    expect(calls).toContainEqual({ method: "getIssue", index: 12 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 7 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 12 });
  });

  test("still posts a review when a linked issue 404s", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPR: async () => makePR({ body: "Fixes #12" }),
          getIssue: async () => {
            throw new Error("Gitea API GET https://gitea.example/issues/12 → 404: not found");
          },
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(result.status).toBe("posted");
      expect(prompt).toContain("Failed to load linked issue #12");
      expect(prompt).toContain("404");
    });
  });

  test("injects Jumi sticky and human comments into the OpenCode prompt", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 10,
              body: "<!-- jumi-review:kirmanak/demo#7 -->\nPrevious findings",
              user: makeUser({ login: "jumi" }),
            }),
            makeComment({
              id: 11,
              body: "please also handle timeouts",
              user: makeUser({ login: "alice" }),
            }),
          ],
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain("Previous findings");
      expect(prompt).toContain("please also handle timeouts");
      expect(prompt).toContain('author="jumi"');
      expect(prompt).toContain('author="alice"');
    });
  });

  test("tags writer comments as product intent and records permission diagnostics", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      const logs: string[] = [];
      await reviewPullRequest({
        ...reviewOptions(workspace),
        logger: (message: string) => {
          logs.push(message);
        },
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 10,
              body: "please handle timeouts",
              user: makeUser({ login: "alice" }),
            }),
            makeComment({
              id: 11,
              body: "me too",
              user: makeUser({ login: "bob" }),
            }),
          ],
          getCollaboratorPermission: async (_owner, _repo, login) => {
            if (login.toLowerCase() === "alice") return { permission: "write" };
            return { permission: "read" };
          },
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain('author="alice"');
      expect(prompt).toContain('permission="write"');
      expect(prompt).toContain('intent="product">');
      expect(prompt).toContain('author="bob"');
      expect(prompt).toContain('permission="read"');
      expect(prompt).toContain('intent="discussion">');
      expect(logs.join("\n")).toContain("event=review_thread");
      expect(logs.join("\n")).toContain("permission_lookups=2");
      expect(logs.join("\n")).toContain("permission_failures=0");
    });
  });

  test("tags maintain role_name as product intent even when permission is not write", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 10,
              body: "please handle timeouts",
              user: makeUser({ login: "alice" }),
            }),
          ],
          getCollaboratorPermission: async () => ({ permission: "read", role_name: "maintain" }),
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain('permission="read"');
      expect(prompt).toContain('intent="product">');
    });
  });

  test("warns and stays fail-closed when permission lookups fail", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      const logs: string[] = [];
      await reviewPullRequest({
        ...reviewOptions(workspace),
        logger: (message: string) => {
          logs.push(message);
        },
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 10,
              body: "please handle timeouts",
              user: makeUser({ login: "alice" }),
            }),
          ],
          getCollaboratorPermission: async () => {
            throw new Error("Gitea API GET /repos/kirmanak/demo/collaborators/alice/permission → 403: forbidden");
          },
        }),
        openCodeRunner: async (opts) => {
          prompt = await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(prompt).toContain('intent="discussion">');
      expect(prompt).toContain('permission="none"');
      expect(prompt).not.toContain('intent="product">');
      expect(logs.join("\n")).toContain("1/1 lookups failed");
      expect(logs.join("\n")).toContain("permission_failures=1");
    });
  });

  const matchingContract = `# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`

#### optional env
- \`HOST\`

### worker

#### required env
- \`GITEA_URL\`

#### gitops env
- \`DATABASE_URL\`

#### optional env
`;
  const matchingReviewer = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "HOST");
`;
  const matchingWorker = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "DATABASE_URL");
`;

  async function writeContractTree(
    workspace: string,
    opts: { contract?: string; reviewer?: string; worker?: string } = {}
  ) {
    await mkdir(join(workspace, "deploy"), { recursive: true });
    await mkdir(join(workspace, "scripts/opencode/src"), { recursive: true });
    await writeFile(join(workspace, "deploy/contract.md"), opts.contract ?? matchingContract);
    await writeFile(join(workspace, "scripts/opencode/src/config.ts"), opts.reviewer ?? matchingReviewer);
    await writeFile(join(workspace, "scripts/opencode/src/worker_config.ts"), opts.worker ?? matchingWorker);
  }

  function personalJumiApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
    const repo = makeRepo({ name: "jumi", owner: makeUser({ login: "personal" }), full_name: "personal/jumi" });
    return makeApi({
      getRepo: async () => repo,
      getPR: async () =>
        makePR({
          html_url: "https://gitea.kirmanak.stream/personal/jumi/pulls/7",
          head: makeBranch({ sha: REVIEW_SHA, repo }),
          base: makeBranch({ repo }),
        }),
      ...overrides,
    });
  }

  test("personal/jumi parent fail-closes a success sticky when loader env drifts from the contract", async () => {
    await withWorkspace(async (workspace) => {
      await writeContractTree(workspace, {
        worker: `${matchingWorker}intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3);\n`,
      });
      const reviews: Array<{ body?: string; comments?: Array<{ body: string }> }> = [];
      let sticky = "";
      const persisted: PersistReviewResult[] = [];
      let ranOpenCode = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        owner: "personal",
        repo: "jumi",
        api: personalJumiApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            sticky = body;
            return makeComment({ id: 123, body });
          },
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        persistResult: async (value) => {
          persisted.push(value);
        },
        openCodeRunner: async () => {
          ranOpenCode = true;
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ranOpenCode).toBe(true);
      expect(result).toEqual({ status: "posted" });
      expect(sticky).toBe("");
      expect(reviews[0]?.body).not.toContain("Looks good");
      expect(reviews[0]?.body).not.toContain("deploy/contract.md:1:");
      expect(lastNonEmptyLine(reviews[0]?.body ?? "")).toBe("<!-- jumi-check: failure; contract env drift -->");
      expect(reviews[0]?.comments?.some((comment) => comment.body.includes("MAX_FOLLOWUP_ROUNDS"))).toBe(true);
      expect(persisted).toEqual([
        {
          kind: "markdown",
          markdown: expect.stringContaining("<!-- jumi-check: failure; contract env drift -->"),
          runner: DEFAULT_RUNNER_STAMP,
        },
      ]);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "contract env drift" });
    });
  });

  test("personal/jumi matching contract keeps OpenCode success", async () => {
    await withWorkspace(async (workspace) => {
      await writeContractTree(workspace);
      const statuses: Array<{ state: string; description?: string }> = [];
      const reviews: Array<{ body?: string }> = [];
      await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        owner: "personal",
        repo: "jumi",
        api: personalJumiApi({
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(lastNonEmptyLine(reviews[0]?.body ?? "")).toBe("<!-- jumi-check: success -->");
      expect(reviews[0]?.body).not.toContain("🟡");
      expect(statuses.at(-1)).toMatchObject({ state: "success" });
    });
  });

  test("personal/jumi parse errors fail closed after OpenCode", async () => {
    await withWorkspace(async (workspace) => {
      await writeContractTree(workspace, { contract: "# not a contract\n" });
      const reviews: Array<{ body?: string; comments?: Array<{ body: string }> }> = [];
      let ranOpenCode = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        owner: "personal",
        repo: "jumi",
        api: personalJumiApi({
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          ranOpenCode = true;
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ranOpenCode).toBe(true);
      expect(reviews[0]?.body).not.toContain("Looks good");
      expect(reviews[0]?.comments?.some((comment) => comment.body.includes("🟡 risk:"))).toBe(true);
      expect(lastNonEmptyLine(reviews[0]?.body ?? "")).toBe("<!-- jumi-check: failure; contract env drift -->");
      expect(statuses.at(-1)?.state).toBe("failure");
    });
  });

  test("other repos are not gated even if the tree is drifted", async () => {
    await withWorkspace(async (workspace) => {
      await writeContractTree(workspace, {
        worker: `${matchingWorker}intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3);\n`,
      });
      const reviews: Array<{ body?: string }> = [];
      await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createPullReview: async (_owner, _repo, _index, review) => {
            reviews.push(review);
            return { id: reviews.length };
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(lastNonEmptyLine(reviews[0]?.body ?? "")).toBe("<!-- jumi-check: success -->");
      expect(reviews[0]?.body).not.toContain("MAX_FOLLOWUP_ROUNDS");
    });
  });
});

describe("applyContractEnvGate", () => {
  test("keeps OpenCode findings and forces a failure trailer", () => {
    const gated = applyContractEnvGate("L12: 🔴 bug: null deref. Guard it.\n<!-- jumi-check: failure; 1 blocking -->", [
      "worker loader env `MAX_FOLLOWUP_ROUNDS` is missing from deploy/contract.md required/optional env",
    ]);
    expect(gated).toContain("L12: 🔴 bug: null deref. Guard it.");
    expect(gated).toContain("deploy/contract.md:1: 🟡 risk: worker loader env `MAX_FOLLOWUP_ROUNDS`");
    expect(gated).not.toContain("💡");
    expect(lastNonEmptyLine(gated)).toBe("<!-- jumi-check: failure; contract env drift -->");
  });
});

describe("publishReviewResult", () => {
  const publishOpts = {
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
  };

  test("SHA moved at publish skips and does not overwrite sticky with stale markdown", async () => {
    let created = false;
    let updated = false;
    let inlined = false;
    const result = await publishReviewResult({
      ...publishOpts,
      expectedHeadSha: "oldsha",
      resultMarkdown: "src/foo.ts:12: 🔴 bug: stale.\n<!-- jumi-check: failure -->",
      api: makeApi({
        getPR: async () => makePR({ head: makeBranch({ sha: "newsha" }) }),
        createIssueComment: async (_owner, _repo, _index, body) => {
          created = true;
          return makeComment({ body });
        },
        updateIssueComment: async (_owner, _repo, commentId, body) => {
          updated = true;
          return makeComment({ id: commentId, body });
        },
        createPullReview: async () => {
          inlined = true;
          return { id: 1 };
        },
      }),
    });
    expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
    expect(created).toBe(false);
    expect(updated).toBe(false);
    expect(inlined).toBe(false);
  });

  test("posts a new pull review per SHA instead of updating a leftover sticky", async () => {
    const reviews: unknown[] = [];
    const first = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "first\n<!-- jumi-check: success -->",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(first).toEqual({ status: "posted" });

    const second = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "💡 simpler: second\n<!-- jumi-check: success; 1 suggestion -->",
      api: makeApi({
        findStickyIssueComment: async () => ({ id: 44 }),
        updateIssueComment: async () => {
          throw new Error("should not update sticky");
        },
        createIssueComment: async () => {
          throw new Error("should not create sticky");
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(second).toEqual({ status: "posted" });
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({
      body: reviewWriteup("💡 simpler: second", "<!-- jumi-check: success; 1 suggestion -->"),
    });
  });

  test("persisted runner stamp sits above the check trailer, which stays last", async () => {
    const reviews: Array<{ body?: string }> = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      resultRunner: "_Jumi · claude · claude-opus-5 (high)_",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    const body = reviews[0]?.body ?? "";
    expect(body).toBe(reviewWriteup("_Jumi · claude · claude-opus-5 (high)_", "<!-- jumi-check: success -->"));
    expect(body).not.toContain("OpenCode");
    expect(lastNonEmptyLine(body)).toBe("<!-- jumi-check: success -->");
  });

  test("publishes an incomplete skip as failure without a review sticky", async () => {
    const comments: string[] = [];
    const statuses: Array<{ state: string; description?: string; context?: string; target_url?: string }> = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultReason: "Incomplete review: no output",
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          comments.push(body);
          return makeComment({ body });
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
    });
    expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
    expect(comments.some((body) => body.includes("jumi-review"))).toBe(false);
    expect(comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
    expect(statuses).toEqual([
      {
        state: "failure",
        context: "jumi/opencode-review",
        description: "Incomplete review: no output",
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
    ]);
  });

  test("an over-long error does not drop a produced review writeup", async () => {
    const reviews: unknown[] = [];
    const statuses: Array<{ state: string; description?: string; context?: string; target_url?: string }> = [];
    const stderr = "x".repeat(500);
    const result = await publishReviewResult({
      ...publishOpts,
      error: `Jumi review failed: opencode exited with code 143:\n${stderr}`,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(reviews).toHaveLength(1);
    expect(statuses).toEqual([
      {
        state: "success",
        context: "jumi/opencode-review",
        description: "No blocking issues",
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
    ]);
    expect(statuses[0]?.description).not.toContain(stderr);
  });

  test("publishes a short failure status for an over-long OpenCode stderr error", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string; target_url?: string }> = [];
    const reviews: unknown[] = [];
    const stderr = `trace ${"x".repeat(400)}`;
    const result = await publishReviewResult({
      ...publishOpts,
      error: `Jumi review failed: opencode exited with code 143:\n${stderr}`,
      api: makeApi({
        createPullReview: async () => {
          reviews.push(true);
          return { id: 1 };
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
    });
    expect(reviews).toEqual([]);
    expect(result).toEqual({
      status: "skipped",
      reason: `Jumi review failed: opencode exited with code 143:\n${stderr}`,
    });
    expect(statuses).toEqual([
      {
        state: "failure",
        context: "jumi/opencode-review",
        description: `Jumi review failed: ${hostname()}: opencode exited with code 143`,
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
    ]);
    expect(statuses[0]?.description).not.toContain(stderr);
    expect(Array.from(statuses[0]?.description ?? "").length).toBeLessThanOrEqual(140);
  });

  test("posts locatable findings as pull-review comments and keeps the writeup trailer", async () => {
    const reviews: unknown[] = [];
    let sticky = "";
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
        "src/foo.ts:40: 💡 simpler: drop the helper.",
        "plain prose without a location",
        "<!-- jumi-check: failure; 1 blocking -->",
      ].join("\n"),
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(sticky).toBe("");
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure; 1 blocking -->"),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 12,
            body: "🔴 bug: null deref. Guard it.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
          {
            path: "src/foo.ts",
            new_position: 40,
            body: "💡 simpler: drop the helper.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("resolves L-form inlines from the single changed file", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "L12: ❓ q: is the timeout intentional?\n<!-- jumi-check: success -->",
      api: makeApi({
        getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "APPROVED",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
        comments: [
          {
            path: "src/demo.ts",
            new_position: 12,
            body: "❓ q: is the timeout intentional?\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("skips L-form inlines when the PR has multiple files", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "L12: 🔴 bug: null deref. Guard it.\n<!-- jumi-check: failure -->",
      api: makeApi({
        getPRFiles: async () => [makeFile({ filename: "a.ts" }), makeFile({ filename: "b.ts" })],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("L12: 🔴 bug: null deref. Guard it.", "<!-- jumi-check: failure -->"),
      },
    ]);
  });

  test("retries inlines individually when the batch is rejected and still publishes the sticky", async () => {
    const reviews: unknown[] = [];
    const logs: string[] = [];
    let sticky = "";
    const result = await publishReviewResult({
      ...publishOpts,
      logger: (message) => logs.push(message),
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) throw new Error("batch rejected");
          if (review.comments?.[0]?.new_position === 40) throw new Error("line not in diff");
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(sticky).toBe("");
    expect(reviews).toHaveLength(4);
    expect(reviews[1]).toMatchObject({
      event: "COMMENT",
      comments: [{ path: "src/foo.ts", new_position: 12 }],
    });
    expect(reviews[3]).toMatchObject({
      commit_id: "headsha",
      event: "REQUEST_CHANGES",
      body: reviewWriteup("src/foo.ts:40: 🟡 risk: second.", "<!-- jumi-check: failure -->"),
    });
    expect(logs.some((line) => line.includes("inline skipped src/foo.ts:40"))).toBe(true);
  });

  test("submits pending reviews after a batch reject then retries only unpublished inlines", async () => {
    const reviews: unknown[] = [];
    const submitted: number[] = [];
    let batchRejected = false;
    let pendingSubmitted = false;
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        listPullReviews: async () =>
          batchRejected && !pendingSubmitted ? [{ id: 99, state: "PENDING", user: makeUser({ login: "jumi" }) }] : [],
        listPullReviewComments: async () =>
          pendingSubmitted
            ? [
                {
                  ...makeComment({
                    id: 11,
                    body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
                    user: makeUser({ login: "jumi" }),
                  }),
                  path: "src/foo.ts",
                  commit_id: "blamesha",
                  new_position: 12,
                },
              ]
            : [],
        submitPullReview: async (_owner, _repo, _index, reviewId, body) => {
          expect(body).toBe("<!-- jumi-review:kirmanak/demo#7 -->");
          pendingSubmitted = true;
          submitted.push(reviewId);
          return { id: reviewId };
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) {
            batchRejected = true;
            throw new Error("batch rejected");
          }
          if (review.comments?.[0]?.new_position === 40) throw new Error("line not in diff");
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(submitted).toEqual([99]);
    expect(reviews).toHaveLength(3);
    expect(reviews[1]).toMatchObject({
      event: "COMMENT",
      comments: [{ path: "src/foo.ts", new_position: 40 }],
    });
    expect(reviews[2]).toMatchObject({
      commit_id: "headsha",
      event: "REQUEST_CHANGES",
      body: reviewWriteup("src/foo.ts:40: 🟡 risk: second.", "<!-- jumi-check: failure -->"),
    });
  });

  test("skips remaining inlines when pending submit fails and still publishes the sticky", async () => {
    const reviews: unknown[] = [];
    const logs: string[] = [];
    let sticky = "";
    let batchRejected = false;
    const result = await publishReviewResult({
      ...publishOpts,
      logger: (message) => logs.push(message),
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        listPullReviews: async () =>
          batchRejected ? [{ id: 99, state: "PENDING", user: makeUser({ login: "jumi" }) }] : [],
        submitPullReview: async () => {
          throw new Error("submit rejected");
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) {
            batchRejected = true;
            throw new Error("batch rejected");
          }
          throw new Error("pending review already exists");
        },
      }),
    });
    expect(result).toEqual({ status: "posted", commentId: 44 });
    expect(lastNonEmptyLine(sticky)).toBe("<!-- jumi-check: failure -->");
    expect(logs.some((line) => line.includes("pending review 99 not submitted"))).toBe(true);
    expect(logs.some((line) => line.includes("inline skipped src/foo.ts:12"))).toBe(true);
    expect(logs.some((line) => line.includes("inline skipped src/foo.ts:40"))).toBe(true);
    expect(reviews).toHaveLength(4);
  });

  test("does not retry inlines when a lost batch 200 already submitted them", async () => {
    const reviews: unknown[] = [];
    let sticky = "";
    let batchRejected = false;
    const submittedReview = {
      id: 7,
      commit_id: "headsha",
      state: "COMMENTED",
      user: makeUser({ login: "jumi" }),
    };
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        listPullReviews: async () => (batchRejected ? [submittedReview] : []),
        listPullReviewComments: async () =>
          batchRejected
            ? [
                {
                  ...makeComment({
                    id: 11,
                    body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
                    user: makeUser({ login: "jumi" }),
                  }),
                  path: "src/foo.ts",
                  new_position: 12,
                  pull_request_review_id: 7,
                },
                {
                  ...makeComment({
                    id: 12,
                    body: "🟡 risk: second.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
                    user: makeUser({ login: "jumi" }),
                  }),
                  path: "src/foo.ts",
                  new_position: 40,
                  pull_request_review_id: 7,
                },
              ]
            : [],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) {
            batchRejected = true;
            throw new Error("timeout");
          }
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(sticky).toBe("");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({
      commit_id: "headsha",
      event: "REQUEST_CHANGES",
      body: reviewWriteup("", "<!-- jumi-check: failure -->"),
    });
  });

  test("retries leftover inlines when pending submit fails", async () => {
    const reviews: unknown[] = [];
    const logs: string[] = [];
    let sticky = "";
    let batchRejected = false;
    const result = await publishReviewResult({
      ...publishOpts,
      logger: (message) => logs.push(message),
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        listPullReviews: async () =>
          batchRejected ? [{ id: 99, state: "PENDING", user: makeUser({ login: "jumi" }) }] : [],
        listPullReviewComments: async () =>
          batchRejected
            ? [
                {
                  ...makeComment({
                    id: 11,
                    body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
                    user: makeUser({ login: "jumi" }),
                  }),
                  path: "src/foo.ts",
                  commit_id: "blamesha",
                  new_position: 12,
                },
              ]
            : [],
        submitPullReview: async () => {
          throw new Error("submit rejected");
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) {
            batchRejected = true;
            throw new Error("batch rejected");
          }
          throw new Error("pending review already exists");
        },
      }),
    });
    expect(result).toEqual({ status: "posted", commentId: 44 });
    expect(lastNonEmptyLine(sticky)).toBe("<!-- jumi-check: failure -->");
    expect(logs.some((line) => line.includes("pending review 99 not submitted"))).toBe(true);
    expect(logs.some((line) => line.includes("inline skipped src/foo.ts:12"))).toBe(true);
    expect(logs.some((line) => line.includes("inline skipped src/foo.ts:40"))).toBe(true);
    expect(reviews).toHaveLength(4);
  });

  test("submits a pending bot review for this SHA before treating inlines as posted", async () => {
    const reviews: unknown[] = [];
    const submitted: number[] = [];
    let pendingSubmitted = false;
    const pendingReview = {
      id: 99,
      state: "PENDING",
      commit_id: "headsha",
      user: makeUser({ login: "jumi" }),
    };
    const pendingComment = {
      ...makeComment({
        id: 11,
        body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/foo.ts",
      commit_id: "blamesha",
      new_position: 12,
      pull_request_review_id: 99,
    };
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviews: async () => (pendingSubmitted ? [{ ...pendingReview, state: "COMMENTED" }] : [pendingReview]),
        listPullReviewComments: async () => [pendingComment],
        submitPullReview: async (_owner, _repo, _index, reviewId, body) => {
          expect(body).toBe("<!-- jumi-review:kirmanak/demo#7 -->");
          pendingSubmitted = true;
          submitted.push(reviewId);
          return { id: reviewId };
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(submitted).toEqual([99]);
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
      },
    ]);
  });

  test("failed pending submit still posts the writeup review and does not treat inlines as posted", async () => {
    const reviews: unknown[] = [];
    const submitted: number[] = [];
    const logs: string[] = [];
    let sticky = "";
    const pendingReview = {
      id: 99,
      state: "PENDING",
      commit_id: "headsha",
      user: makeUser({ login: "jumi" }),
    };
    const result = await publishReviewResult({
      ...publishOpts,
      logger: (message) => logs.push(message),
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        listPullReviews: async () => [pendingReview],
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 12,
            pull_request_review_id: 99,
          },
        ],
        submitPullReview: async (_owner, _repo, _index, reviewId) => {
          submitted.push(reviewId);
          throw new Error("submit rejected");
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(sticky).toBe("");
    expect(submitted).toEqual([99]);
    expect(logs.some((line) => line.includes("pending review 99 not submitted"))).toBe(true);
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 12,
            body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("skips inlines already posted with the same path and normalized text", async () => {
    const reviews: unknown[] = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        listPullReviews: async () => [
          { id: 5, commit_id: "headsha", user: makeUser({ login: "jumi" }) },
          { id: 6, commit_id: "headsha", user: makeUser({ login: "alice" }) },
        ],
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 12,
            pull_request_review_id: 5,
          },
          {
            ...makeComment({
              id: 12,
              body: "please rename this helper",
              user: makeUser({ login: "alice" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 40,
            pull_request_review_id: 6,
          },
        ],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 40,
            body: "🟡 risk: second.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("leaves an unresolved fingerprint on a new SHA and still posts the review event", async () => {
    const reviews: unknown[] = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:18: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviews: async () => [{ id: 5, commit_id: "oldsha", user: makeUser({ login: "jumi" }) }],
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 12,
            pull_request_review_id: 5,
          },
        ],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
      },
    ]);
  });

  test("still posts REQUEST_CHANGES when every inline already exists", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviews: async () => [{ id: 5, commit_id: "headsha", user: makeUser({ login: "jumi" }) }],
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 12,
            pull_request_review_id: 5,
          },
        ],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
      },
    ]);
  });

  test("does not duplicate a leftover inline whose comment commit_id is a blame SHA", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "src/foo.ts:12: 🔴 bug: first.",
        "src/foo.ts:40: 🟡 risk: second.",
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      api: makeApi({
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            commit_id: "blamesha",
            new_position: 12,
          },
        ],
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if ((review.comments?.length ?? 0) > 1) throw new Error("batch rejected");
          return { id: reviews.length };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 40,
            body: "🟡 risk: second.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("submits leftover pending bot reviews from a previous SHA before creating a new review", async () => {
    const submitted: number[] = [];
    const reviews: unknown[] = [];
    let pendingSubmitted = false;
    const pendingReview = {
      id: 99,
      state: "PENDING",
      commit_id: "oldsha",
      user: makeUser({ login: "jumi" }),
    };
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        listPullReviews: async () => (pendingSubmitted ? [] : [pendingReview]),
        submitPullReview: async (_owner, _repo, _index, reviewId, body) => {
          expect(body).toBe("<!-- jumi-review:kirmanak/demo#7 -->");
          pendingSubmitted = true;
          submitted.push(reviewId);
          return { id: reviewId };
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: reviews.length };
        },
      }),
    });
    expect(result).toEqual({ status: "posted" });
    expect(submitted).toEqual([99]);
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "APPROVED",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
    ]);
  });

  test("submits a pending review from a previous head SHA after a batch reject", async () => {
    const submitted: number[] = [];
    const reviews: unknown[] = [];
    let batchRejected = false;
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviews: async () =>
          batchRejected ? [{ id: 99, state: "PENDING", commit_id: "oldsha", user: makeUser({ login: "jumi" }) }] : [],
        submitPullReview: async (_owner, _repo, _index, reviewId) => {
          submitted.push(reviewId);
          return { id: reviewId };
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if (!batchRejected) {
            batchRejected = true;
            throw new Error("batch rejected");
          }
          return { id: reviews.length };
        },
      }),
    });
    expect(submitted).toEqual([99]);
    expect(reviews).toHaveLength(3);
    expect(reviews[2]).toMatchObject({
      commit_id: "headsha",
      event: "REQUEST_CHANGES",
      body: reviewWriteup("", "<!-- jumi-check: failure -->"),
    });
  });

  test("inline posting errors still publish the sticky trailer", async () => {
    let sticky = "";
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        getPRFiles: async () => {
          throw new Error("files exploded");
        },
        listPullReviewComments: async () => {
          throw new Error("inlines exploded");
        },
        createPullReview: async () => {
          throw new Error("inlines exploded");
        },
      }),
    });
    expect(result).toEqual({ status: "posted", commentId: 44 });
    expect(lastNonEmptyLine(sticky)).toBe("<!-- jumi-check: failure -->");
  });

  test("does not post inlines for an incomplete artifact", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([]);
  });

  test("self-review on a jumi-authored PR falls back to COMMENT", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        getPR: async () => makePR({ user: makeUser({ login: "jumi" }) }),
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "COMMENT",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
    ]);
  });

  test("falls back to COMMENT when Gitea rejects APPROVED as self-review", async () => {
    const reviews: unknown[] = [];
    const logs: string[] = [];
    await publishReviewResult({
      ...publishOpts,
      logger: (message) => logs.push(message),
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          if (review.event === "APPROVED") throw new Error("not allowed to approve your own pull request");
          return { id: reviews.length };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "APPROVED",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
      {
        commit_id: "headsha",
        event: "COMMENT",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
    ]);
    expect(logs.some((line) => line.includes("falling back to COMMENT"))).toBe(true);
  });

  test("COMMENT fallback on success does not dismiss earlier REQUEST_CHANGES", async () => {
    const dismissed: number[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        listPullReviews: async () => [
          { id: 9, state: "REQUEST_CHANGES", user: makeUser({ login: "jumi" }) },
          { id: 10, state: "REQUEST_CHANGES", dismissed: true, user: makeUser({ login: "jumi" }) },
        ],
        createPullReview: async (_owner, _repo, _index, review) => {
          if (review.event === "APPROVED") throw new Error("not allowed to approve your own pull request");
          return { id: 11 };
        },
        dismissPullReview: async (_owner, _repo, _index, reviewId) => {
          dismissed.push(reviewId);
          return { id: reviewId };
        },
      }),
    });
    expect(dismissed).toEqual([]);
  });

  test("resolves gone inlines and unresolves a finding that came back", async () => {
    const resolved: number[] = [];
    const unresolved: number[] = [];
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:12: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            new_position: 12,
            resolved: true,
          },
          {
            ...makeComment({
              id: 12,
              body: "🟡 risk: second.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            new_position: 40,
          },
        ],
        resolvePullComment: async (_owner, _repo, commentId) => {
          resolved.push(commentId);
        },
        unresolvePullComment: async (_owner, _repo, commentId) => {
          unresolved.push(commentId);
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(resolved).toEqual([12]);
    expect(unresolved).toEqual([11]);
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
      },
    ]);
  });

  test("posts a new inline when unresolve fails for a finding that came back", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "src/foo.ts:18: 🔴 bug: first.\n<!-- jumi-check: failure -->",
      api: makeApi({
        listPullReviewComments: async () => [
          {
            ...makeComment({
              id: 11,
              body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
              user: makeUser({ login: "jumi" }),
            }),
            path: "src/foo.ts",
            new_position: 12,
            resolved: true,
          },
        ],
        unresolvePullComment: async () => {
          throw new Error("unresolve rejected");
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", "<!-- jumi-check: failure -->"),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 18,
            body: "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);
  });

  test("falls back to an issue comment only when every pull review create fails", async () => {
    let sticky = "";
    const reviews: unknown[] = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        getPR: async () => makePR({ user: makeUser({ login: "jumi" }) }),
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          throw new Error("not allowed to review your own pull request");
        },
      }),
    });
    expect(result).toEqual({ status: "posted", commentId: 44 });
    expect(reviews).toHaveLength(1);
    expect(lastNonEmptyLine(sticky)).toBe("<!-- jumi-check: success -->");
    expect(sticky).not.toContain("Looks good");
  });

  test("an essay plus a success trailer publishes as the trailer only", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: [
        "## What I checked",
        "",
        "I traced `publishReviewResult` and the diff adds a helper that filters the body.",
        "",
        "No blocking findings on this SHA.",
        "<!-- jumi-check: success -->",
      ].join("\n"),
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "APPROVED",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
    ]);
  });

  test("a finding line plus a tour publishes the finding and the trailer, not the tour", async () => {
    const tour = [
      "## Tour",
      "The PR moves the filter into the publish path; I verified each caller.",
      "There may be a bug in the retry loop, but I did not confirm it.",
    ];
    const finding = "src/foo.ts:12: 🔴 bug: null deref. Guard it.";
    const trailer = "<!-- jumi-check: failure; 1 blocking -->";
    const resultMarkdown = [...tour, "", finding, trailer].join("\n");

    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown,
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "REQUEST_CHANGES",
        body: reviewWriteup("", trailer),
        comments: [
          {
            path: "src/foo.ts",
            new_position: 12,
            body: "🔴 bug: null deref. Guard it.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
          },
        ],
      },
    ]);

    let sticky = "";
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown,
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          sticky = body;
          return makeComment({ id: 44, body });
        },
        createPullReview: async () => {
          throw new Error("pull reviews unavailable");
        },
      }),
    });
    expect(sticky).toBe(reviewWriteup(finding, trailer));
    for (const line of tour) expect(sticky).not.toContain(line);
  });

  test("success with no locatable findings still posts APPROVED", async () => {
    const reviews: unknown[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "Looks good\n<!-- jumi-check: success -->",
      api: makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviews.push(review);
          return { id: 1 };
        },
      }),
    });
    expect(reviews).toEqual([
      {
        commit_id: "headsha",
        event: "APPROVED",
        body: reviewWriteup("", "<!-- jumi-check: success -->"),
      },
    ]);
  });
});
