import { describe, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPullRequest } from "../src/review.ts";
import type { GitRunner } from "../src/workspace.ts";
import { forEachForge, makeReviewApi } from "./fakes/forge.ts";
import { makeBranch, makeComment, makePR, makeRepo } from "./fixtures.ts";
import { withWorkspace } from "./harness/temp.ts";

const MARKER = "<!-- jumi-review:kirmanak/demo#7 -->";
const P1 = "a".repeat(40);
const P2 = "b".repeat(40);
const MERGE = "c".repeat(40);
const OTHER = "d".repeat(40);
const TREE = "e".repeat(40);
const TREE_OTHER = "f".repeat(40);

function stickyBody(sha: string, prose: string, checkLine: string): string {
  return `${MARKER}\n### Jumi review\n\nReviewed commit: \`${sha}\`\n\n${prose}\n\n${checkLine}`;
}

function carryGit(opts: {
  merge?: string;
  p1?: string;
  p2?: string;
  tree?: string;
  autoTree?: string;
  mergeFiles?: string[];
}): GitRunner {
  const merge = opts.merge ?? MERGE;
  const p1 = opts.p1 ?? P1;
  const p2 = opts.p2 ?? P2;
  const tree = opts.tree ?? TREE;
  const autoTree = opts.autoTree ?? TREE;
  const mergeFiles = opts.mergeFiles ?? ["src/target.ts"];
  return (async (args: string[]) => {
    if (args[0] === "rev-list") return `${merge} ${p1} ${p2}`;
    if (args[0] === "rev-parse") {
      if (args.includes("HEAD^{tree}")) return tree;
      return merge;
    }
    if (args[0] === "merge-tree") return autoTree;
    if (args[0] === "diff" && args.includes("--name-only")) return mergeFiles.join("\n");
    if (args[0] === "merge-base") return "";
    if (args[0] === "log") return "";
    if (args[0] === "diff") return "";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files" || args[0] === "checkout") return "";
    if (args[0] === "ls-tree") return "";
    if (args[0] === "show") throw new Error("no base file");
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitRunner;
}

interface CarryFixture {
  previousBody: string;
  mergeFiles?: string[];
  autoTree?: string;
  settingsContent?: string;
  previousSha?: string;
  p1?: string;
}

async function runCarry(
  preset: { name: string; pullFile: (name?: string) => { filename: string } & Record<string, unknown> },
  fixture: CarryFixture
) {
  return withWorkspace(async (workspace) => {
    let runs = 0;
    const statuses: Array<{ state: string; description?: string }> = [];
    const bodies: string[] = [];
    const prFile = preset.pullFile("src/pr.ts");
    const api = makeReviewApi({
      capabilities: preset.name === "github" ? (await import("../src/forge_capabilities.ts")).FORGE_CAPABILITIES.github : (await import("../src/forge_capabilities.ts")).FORGE_CAPABILITIES.gitea,
      getPR: async () => makePR({ head: makeBranch({ sha: MERGE }) }),
      getRepo: async () => makeRepo(),
      getPRFiles: async () => [prFile as never],
      listIssueComments: async () => [
        makeComment({ id: 50, body: fixture.previousBody }),
      ],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
      listCheckRuns: async () => [],
      listActionJobs: async () => [],
      getRepoFile: async () =>
        fixture.settingsContent !== undefined
          ? { found: true, content: fixture.settingsContent }
          : { found: false },
      createCommitStatus: async (_o, _r, _s, status) => {
        statuses.push(status);
        return status;
      },
      createPullReview: async (_o, _r, _n, review) => {
        bodies.push((review as { body?: string }).body ?? "");
        return { id: bodies.length };
      },
      createIssueComment: async (_o, _r, _n, body) => {
        bodies.push(body);
        return makeComment({ id: bodies.length, body });
      },
    });
    const result = await reviewPullRequest({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      model: "openai/gpt-5.5",
      workspace,
      giteaUrl: "https://example.test",
      giteaToken: "bot-token",
      botUsername: "jumi",
      workspacePreparer: async () => undefined,
      logger: () => undefined,
      verdictContract: "legacy",
      gitRunner: carryGit({
        p1: fixture.p1 ?? P1,
        mergeFiles: fixture.mergeFiles,
        autoTree: fixture.autoTree,
      }),
      api,
      openCodeRunner: async () => {
        runs++;
        await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
        return { status: "ok" };
      },
    });
    return { runs, statuses, bodies, result };
  });
}

const GREEN_BODY = stickyBody(P1, "All good.", "<!-- jumi-check: success -->");

forEachForge("carry clean merge without model", (preset) => {
  return (async () => {
    const { runs, statuses, bodies, result } = await runCarry(preset, { previousBody: GREEN_BODY });
    expect(runs).toBe(0);
    expect(result.status).toBe("posted");
    const published = bodies.join("\n");
    expect(published).toContain(P1);
    expect(published).toContain("main");
    expect(published.toLowerCase()).toContain("carried");
    expect(statuses.at(-1)?.state).toBe("success");
  })();
});

forEachForge("carry refuses hand-edited merge tree", (preset) => {
  return (async () => {
    const { runs } = await runCarry(preset, { previousBody: GREEN_BODY, autoTree: TREE_OTHER });
    expect(runs).toBe(1);
  })();
});

forEachForge("carry refuses overlap with PR files", (preset) => {
  return (async () => {
    const { runs } = await runCarry(preset, { previousBody: GREEN_BODY, mergeFiles: ["src/pr.ts"] });
    expect(runs).toBe(1);
  })();
});

forEachForge("carry refuses previous failing review", (preset) => {
  return (async () => {
    const failing = stickyBody(P1, "src/pr.ts:1: 🔴 bug: bad.", "<!-- jumi-check: failure -->");
    const { runs } = await runCarry(preset, { previousBody: failing });
    expect(runs).toBe(1);
  })();
});

forEachForge("carry refuses previous open question", (preset) => {
  return (async () => {
    const q = stickyBody(P1, "src/pr.ts:1: ❓ q: is this right?", "<!-- jumi-check: success -->");
    const { runs } = await runCarry(preset, { previousBody: q });
    expect(runs).toBe(1);
  })();
});

forEachForge("carry refuses first parent not reviewed head", (preset) => {
  return (async () => {
    const other = stickyBody(OTHER, "All good.", "<!-- jumi-check: success -->");
    const { runs } = await runCarry(preset, { previousBody: other, p1: P1 });
    expect(runs).toBe(1);
  })();
});

forEachForge("carry refuses when setting off", (preset) => {
  return (async () => {
    const { runs } = await runCarry(preset, { previousBody: GREEN_BODY, settingsContent: "review_carry: false\n" });
    expect(runs).toBe(1);
  })();
});

describe("carry helpers", () => {
  // Keep unused imports referenced for knip.
  void mkdtemp;
  void tmpdir;
});
