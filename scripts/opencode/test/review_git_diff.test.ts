import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullFile } from "../src/ports.ts";
import { fillMissingVerdictPatches, reviewPullRequest, splitGitDiffByFile } from "../src/review.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeBranch, makePR, makeRepo } from "./fixtures.ts";

const MODIFIED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,5 @@",
  " context",
  "-old",
  "+new line two",
  "+new line three",
  " context",
  " tail",
].join("\n");

const NEW_FILE_DIFF = [
  "diff --git a/dnd/recap_check.py b/dnd/recap_check.py",
  "new file mode 100644",
  "index 0000000..1234567",
  "--- /dev/null",
  "+++ b/dnd/recap_check.py",
  "@@ -0,0 +1,2 @@",
  "+line one",
  "+line two",
].join("\n");

describe("git diff hunk backfill", () => {
  test("splitGitDiffByFile maps a batched diff back to per-file patches", () => {
    const combined = `${MODIFIED_DIFF}\n${NEW_FILE_DIFF}`;
    const byFile = splitGitDiffByFile(combined);
    expect(byFile.get("src/a.ts")).toContain("@@ -1,3 +1,5 @@");
    expect(byFile.get("dnd/recap_check.py")).toContain("@@ -0,0 +1,2 @@");
    expect(byFile.get("src/a.ts")).not.toContain("recap_check");
  });

  test("a store built from Gitea-shaped files plus parent diffs accepts new lines", () => {
    const combined = `${MODIFIED_DIFF}\n${NEW_FILE_DIFF}`;
    const byFile = splitGitDiffByFile(combined);
    const changedFiles: PullFile[] = [
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, changes: 3 },
      { filename: "dnd/recap_check.py", status: "added", additions: 2, deletions: 0, changes: 2 },
    ];
    const withPatches = changedFiles.map((file) => {
      const patch = byFile.get(file.filename);
      return patch ? { ...file, patch } : file;
    });
    const store = new ReviewVerdictStore({ changedFiles: withPatches });
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "risk", body: "race" }).ok).toBe(true);
    expect(store.addFinding({ path: "dnd/recap_check.py", line: 1, severity: "risk", body: "first" }).ok).toBe(true);
    const outside = store.addFinding({ path: "src/a.ts", line: 999, severity: "risk", body: "nope" });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toMatch(/line outside hunks/);
  });

  test("a forge patch wins and git is not consulted for that file", async () => {
    const forgePatch = ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return MODIFIED_DIFF;
    };
    const out = await fillMissingVerdictPatches({
      git,
      cwd: "/work",
      env: {},
      changedFiles: [
        { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: forgePatch },
        { filename: "src/b.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
      ],
    });
    expect(out.find((file) => file.filename === "src/a.ts")?.patch).toBe(forgePatch);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["diff", "jumi/target...HEAD"]);
    expect(calls[0]).toContain("src/b.ts");
    expect(calls[0]).not.toContain("src/a.ts");
  });

  test("excluded files are never sent to git", async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return "";
    };
    const out = await fillMissingVerdictPatches({
      git,
      cwd: "/work",
      env: {},
      changedFiles: [{ filename: "gen/out.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
      excludedFiles: ["gen/out.ts"],
    });
    expect(out[0]?.patch).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("binary and rename-only files reject with an unlocated-finding hint", () => {
    const binaryPatch = [
      "diff --git a/img/logo.png b/img/logo.png",
      "new file mode 100644",
      "index 0000000..1234567",
      "Binary files /dev/null and b/img/logo.png differ",
    ].join("\n");
    const renamePatch = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts",
    ].join("\n");
    const store = new ReviewVerdictStore({
      changedFiles: [
        { filename: "img/logo.png", patch: binaryPatch },
        { filename: "new/name.ts", patch: renamePatch },
      ],
    });
    for (const path of ["img/logo.png", "new/name.ts"]) {
      const out = store.addFinding({ path, line: 1, severity: "risk", body: "looks off" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toMatch(/line outside hunks/);
        expect(out.error).toMatch(/no path and line/);
      }
    }
    expect(store.addFinding({ severity: "risk", body: "general concern" }).ok).toBe(true);
  });
});

describe("review with Gitea-shaped files (no forge patch)", () => {
  test("child 🟡 with path and line publishes an inline finding with failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-gitea-diff-"));
    try {
      const statuses: Array<{ state: string; description?: string }> = [];
      const createdReviews: Array<{ commit_id: string; event: string; comments?: unknown[]; body?: string }> = [];
      const api = makeReviewApi({
        getRepo: async () => makeRepo() as unknown as import("../src/ports.ts").Repo,
        getPR: async () =>
          makePR({ head: makeBranch({ sha: "headsha" }) }) as unknown as import("../src/ports.ts").Pull,
        getPRFiles: async () => [
          { filename: "src/demo.ts", status: "modified", additions: 1, deletions: 1, changes: 2 } as PullFile,
        ],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
        createPullReview: async (_owner, _repo, _index, review) => {
          createdReviews.push(review as { commit_id: string; event: string; comments?: unknown[]; body?: string });
          return { id: 1 };
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      });
      const gitRunner: GitRunner = async (args) => {
        if (args[0] === "rev-parse") return "headsha";
        if (args[0] === "status") return "?? JUMI_REVIEW.md";
        if (args[0] === "ls-files") return "";
        if (args[0] === "checkout") return "";
        if (args[0] === "diff") {
          expect(args.slice(0, 2)).toEqual(["diff", "jumi/target...HEAD"]);
          expect(args).toContain("--");
          expect(args).toContain("src/demo.ts");
          return [
            "diff --git a/src/demo.ts b/src/demo.ts",
            "index 1111111..2222222 100644",
            "--- a/src/demo.ts",
            "+++ b/src/demo.ts",
            "@@ -1,2 +1,2 @@",
            " one",
            "-old",
            "+two",
          ].join("\n");
        }
        if (args[0] === "ls-tree") return "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      const result = await reviewPullRequest({
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.example",
        giteaToken: "bot-token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        logger: () => undefined,
        api,
        gitRunner,
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { reviewMcp?: { url: string; token: string } }).reviewMcp;
          expect(mcp?.url).toBeTruthy();
          const added = await probeReviewMcpServer(mcp!.url, mcp!.token, "add_finding", {
            path: "src/demo.ts",
            line: 2,
            severity: "risk",
            body: "race on retry",
          });
          expect(added.ok).toBe(true);
          const verdict = await probeReviewMcpServer(mcp!.url, mcp!.token, "set_verdict", {
            state: "failure",
            reason: "1 risk",
          });
          expect(verdict.ok).toBe(true);
          return { status: "ok" };
        },
      });
      expect(result.status).toBe("posted");
      expect(result.reason).not.toBe("Incomplete review: no findings");
      const inlineBatch = createdReviews.find((review) => Array.isArray(review.comments) && review.comments.length > 0);
      expect(inlineBatch).toBeDefined();
      expect(JSON.stringify(inlineBatch)).toContain("src/demo.ts");
      expect(statuses.at(-1)?.state).toBe("failure");
      expect(statuses.at(-1)?.description).toContain("1 risk");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
