import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import { publishReviewResult, type ReviewApi, reviewPullRequest } from "../src/review.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";
import { frozenGit } from "./harness/git.ts";
import { withWorkspace } from "./harness/temp.ts";

function excludesApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return makeReviewApi({
    getPRFiles: async () => [makeFile()],
    getIssue: async () => {
      throw new Error("not used");
    },
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  });
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

describe("review_exclude end to end", () => {
  test("an excluded patch is absent from the prompt but the file stays listed as left out", async () => {
    await withWorkspace(async (workspace) => {
      let task = "";
      const bodies: Array<{ body?: string }> = [];
      const result = await reviewPullRequest({
        ...skipOptions,
        workspace,
        gitRunner: frozenGit(),
        api: excludesApi({
          getPRFiles: async () => [
            makeFile({ filename: "src/app.ts", patch: "@@ -1 +1 @@\n-old\n+new-app" }),
            makeFile({ filename: "src/generated/foo.ts", patch: "GENERATED_PATCH_BODY" }),
          ],
          getRepoFile: async () => ({ found: true, content: 'review_exclude:\n  - "**/generated/**"\n' }),
          createPullReview: async (_o, _r, _n, review) => {
            bodies.push(review);
            return { id: bodies.length };
          },
        }),
        openCodeRunner: async () => {
          task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
      expect(task).toContain("src/app.ts");
      expect(task).toContain("new-app");
      expect(task).not.toContain("GENERATED_PATCH_BODY");
      expect(task).toContain('excluded="true"');
      expect(task).toContain("<excluded_files");
      expect(task).toContain("src/generated/foo.ts");
      const published = bodies.map((review) => review.body ?? "").join("\n");
      expect(published).toContain("src/generated/foo.ts");
      expect(published).toContain("`review_exclude`");
    });
  });

  test("a pattern matching the settings file does not hide it", async () => {
    await withWorkspace(async (workspace) => {
      let task = "";
      await reviewPullRequest({
        ...skipOptions,
        workspace,
        gitRunner: frozenGit(),
        api: excludesApi({
          getPRFiles: async () => [
            makeFile({ filename: ".jumi.yml", patch: "SETTINGS_PATCH_BODY" }),
            makeFile({ filename: "src/app.ts", patch: "APP_PATCH_BODY" }),
          ],
          getRepoFile: async () => ({ found: true, content: 'review_exclude:\n  - "**"\n' }),
        }),
        openCodeRunner: async () => {
          task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(task).toContain("SETTINGS_PATCH_BODY");
      expect(task).not.toContain("APP_PATCH_BODY");
    });
  });

  test("an all-excluded pull still gets a review that says nothing was read", async () => {
    await withWorkspace(async (workspace) => {
      const bodies: Array<{ body?: string }> = [];
      const statuses: Array<{ state: string }> = [];
      const result = await reviewPullRequest({
        ...skipOptions,
        workspace,
        gitRunner: frozenGit(),
        api: excludesApi({
          getPRFiles: async () => [makeFile({ filename: "pnpm-lock.yaml", patch: "LOCK_PATCH" })],
          getRepoFile: async () => ({ found: true, content: 'review_exclude:\n  - "pnpm-lock.yaml"\n' }),
          createPullReview: async (_o, _r, _n, review) => {
            bodies.push(review);
            return { id: bodies.length };
          },
          createCommitStatus: async (_o, _r, _s, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          expect(task).not.toContain("LOCK_PATCH");
          expect(task).toContain("nothing was read");
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Nothing to review.\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "posted" });
      expect(statuses.at(-1)?.state).toBe("success");
      expect(bodies.map((review) => review.body ?? "").join("\n")).toContain("No patches were read");
    });
  });

  test("patterns come from the default branch: a pull that adds them is reviewed in full", async () => {
    await withWorkspace(async (workspace) => {
      const refs: string[] = [];
      let task = "";
      await reviewPullRequest({
        ...skipOptions,
        workspace,
        gitRunner: frozenGit(),
        api: excludesApi({
          getPRFiles: async () => [
            makeFile({ filename: ".jumi.yml", patch: "added review_exclude" }),
            makeFile({ filename: "src/app.ts", patch: "APP_PATCH_BODY" }),
          ],
          getRepoFile: async (_o, _r, _p, ref) => {
            refs.push(ref);
            return { found: false };
          },
        }),
        openCodeRunner: async () => {
          task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(refs.length).toBeGreaterThan(0);
      expect(refs).toContain("main");
      // The head file is also read because the pull changes it, but the
      // exclude patterns still come from the default branch.
      for (const ref of refs) expect(["main", "headsha"]).toContain(ref);
      expect(task).toContain("APP_PATCH_BODY");
      expect(task).not.toContain("<excluded_files");
    });
  });

  test("a repository without the setting is reviewed as today", async () => {
    await withWorkspace(async (workspace) => {
      let task = "";
      const bodies: Array<{ body?: string }> = [];
      await reviewPullRequest({
        ...skipOptions,
        workspace,
        gitRunner: frozenGit(),
        api: excludesApi({
          getPRFiles: async () => [makeFile({ filename: "src/app.ts", patch: "APP_PATCH_BODY" })],
          createPullReview: async (_o, _r, _n, review) => {
            bodies.push(review);
            return { id: bodies.length };
          },
        }),
        openCodeRunner: async () => {
          task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
          await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(task).toContain("APP_PATCH_BODY");
      expect(task).not.toContain("<excluded_files");
      expect(bodies.map((review) => review.body ?? "").join("\n")).not.toContain("review_exclude");
    });
  });
});

describe("publishReviewResult with excludes", () => {
  test("appends the left-out note even when the child omitted it", async () => {
    const bodies: string[] = [];
    await publishReviewResult({
      api: excludesApi({
        createPullReview: async (_o, _r, _n, review) => {
          bodies.push(review.body ?? "");
          return { id: 1 };
        },
      }),
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      resultMarkdown: "src/app.ts:1: 🔴 bug: bad.\n<!-- jumi-check: failure -->",
      excludedFiles: ["src/generated/foo.ts"],
    });
    expect(bodies.join("\n")).toContain("src/generated/foo.ts");
    expect(bodies.join("\n")).toContain("`review_exclude`");
  });

  test("a child disclosure mentioning review_exclude does not suppress the parent note", async () => {
    const bodies: string[] = [];
    await publishReviewResult({
      api: excludesApi({
        createPullReview: async (_o, _r, _n, review) => {
          bodies.push(review.body ?? "");
          return { id: 1 };
        },
      }),
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      resultMarkdown:
        "Left out per `.jumi.yml` `review_exclude`: `src/generated/foo.ts`.\n" +
        "src/app.ts:1: 🔴 bug: bad.\n" +
        "<!-- jumi-check: failure -->",
      excludedFiles: ["src/generated/foo.ts"],
    });
    const published = bodies.join("\n");
    expect(published).toContain("src/generated/foo.ts");
    expect(published).toContain("Left out of review per");
    expect(published).toContain("src/app.ts");
  });

  test("a finding that mentions review_exclude survives intact", async () => {
    const bodies: string[] = [];
    await publishReviewResult({
      api: excludesApi({
        createPullReview: async (_o, _r, _n, review) => {
          bodies.push(review.body ?? "");
          return { id: 1 };
        },
      }),
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      resultMarkdown: "src/auth.ts:12: 🔴 bug: `review_exclude` pattern `**` hides auth\n<!-- jumi-check: failure -->",
      excludedFiles: ["src/generated/foo.ts"],
    });
    const published = bodies.join("\n");
    expect(published).toContain("src/auth.ts");
    expect(published).toContain("hides auth");
    expect(published).toContain("src/generated/foo.ts");
  });
});

describe("buildPROpenedPrompt with excludes", () => {
  test("marks excluded files and omits their patches, including in later reviews", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [
        makeFile({ filename: "src/app.ts", patch: "APP" }),
        makeFile({ filename: "src/generated/foo.ts", patch: "GENERATED" }),
      ],
      excludedFiles: ["src/generated/foo.ts"],
      delta: {
        previousSha: "abc1234",
        findings: [],
        commits: ["abc1234 fix"],
        files: [
          makeFile({ filename: "src/app.ts", patch: "APP" }),
          makeFile({ filename: "src/generated/foo.ts", patch: "GENERATED" }),
        ],
      },
    });
    expect(prompt).toContain('excluded="true"');
    expect(prompt).toContain("<excluded_files");
    expect(prompt).toContain("src/generated/foo.ts");
    expect(prompt).not.toContain("GENERATED");
    expect(prompt).toContain("APP");
  });

  test("later reviews resolve the repeat/excluded conflict in favor of excluded_files", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [makeFile({ filename: "src/app.ts", patch: "APP" })],
      excludedFiles: ["src/generated/foo.ts"],
      delta: {
        previousSha: "abc1234",
        findings: ["src/generated/foo.ts:1: 🔴 bug: old."],
        commits: ["abc1234 fix"],
        files: [makeFile({ filename: "src/app.ts", patch: "APP" })],
      },
    });
    expect(prompt).toContain("<excluded_files");
    expect(prompt).toContain("<excluded_files> wins that conflict");
  });
});
