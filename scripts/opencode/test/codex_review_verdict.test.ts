import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_ARTIFACT, runCodex } from "../src/codex.ts";
import { codexJobDir } from "../src/codex_home.ts";
import type { PersistReviewResult, ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import type { NamedRunner } from "../src/runners.ts";
import { emptyCiMethods, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";
import { withFakeBins } from "./harness/bins.ts";

const AGENT = JSON.stringify({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "done" },
});

const CODEX_CHAIN: NamedRunner[] = [{ name: "codex", type: "codex", model: "gpt-6-sol", effort: "high" }];

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
  if (args[0] === "status") return `?? ${REVIEW_ARTIFACT}`;
  if (args[0] === "ls-files") return "";
  if (args[0] === "checkout") return "";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

/** Shell preamble: recover this spawn's review MCP URL and bearer token from the harness config. */
const MCP_PREAMBLE = [
  `MCP_URL=$(grep -o 'http://127\\.0\\.0\\.1:[0-9]*/mcp' "$CODEX_HOME/config.toml" | head -n 1)`,
  `MCP_TOKEN=$(grep -o 'Bearer [A-Za-z0-9]*' "$CODEX_HOME/config.toml" | head -n 1 | cut -d' ' -f2)`,
].join("\n");

function mcpCall(id: number, tool: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  return `curl -s -o /dev/null -X POST "$MCP_URL" -H 'content-type: application/json' -H "Authorization: Bearer $MCP_TOKEN" --data-binary '${payload}'`;
}

function mcpBin(lines: string[]): string {
  return `#!/bin/sh
[ -n "$ARGS_LOG" ] && printf 'codex %s\\n' "$*" >> "$ARGS_LOG"
${MCP_PREAMBLE}
${lines.join("\n")}
exit 0
`;
}

interface SyntheticCodexRun {
  result: { status: string; reason?: string };
  persisted: PersistReviewResult[];
  statuses: Array<{ state: string; description?: string }>;
  reviews: number;
  comments: string[];
}

async function syntheticCodexReview(opts: {
  codexBin: string;
  verdictContract?: "required" | "legacy";
  maxIncompleteRetries?: number;
}): Promise<SyntheticCodexRun> {
  let outcome!: SyntheticCodexRun;
  await withFakeBins({ codex: opts.codexBin }, async ({ workdir, home }) => {
    const persisted: PersistReviewResult[] = [];
    const statuses: Array<{ state: string; description?: string }> = [];
    const comments: string[] = [];
    let reviews = 0;
    const result = (await reviewPullRequest({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      model: "gpt-6-sol",
      chain: CODEX_CHAIN,
      workspace: workdir,
      home,
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
        createPullReview: async () => {
          reviews++;
          return { id: reviews };
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
    })) as { status: string; reason?: string };
    outcome = { result, persisted, statuses, reviews, comments };
  });
  return outcome;
}

describe("codex adapter verdict contract", () => {
  test("required contract returns ok without an artifact", async () => {
    await withFakeBins({ codex: `#!/bin/sh\nprintf '%s\\n' '${AGENT}'` }, async ({ workdir, home, argsLog }) => {
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
        verdictContract: "required",
      });
      expect(result.status).toBe("ok");
    });
  });

  test("a wired review MCP without an explicit contract returns ok without an artifact", async () => {
    await withFakeBins({ codex: `#!/bin/sh\nprintf '%s\\n' '${AGENT}'` }, async ({ workdir, home, argsLog }) => {
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
        reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
      });
      expect(result.status).toBe("ok");
    });
  });

  test("explicit legacy contract still rejects missing output", async () => {
    await withFakeBins({ codex: `#!/bin/sh\nprintf '%s\\n' '${AGENT}'` }, async ({ workdir, home, argsLog }) => {
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
        verdictContract: "legacy",
      });
      expect(result.status).toBe("exit");
      expect(result.message).toContain("no artifact");
    });
  });

  test("explicit legacy contract still rejects empty output", async () => {
    await withFakeBins(
      { codex: `#!/bin/sh\n: > "${REVIEW_ARTIFACT}"\nprintf '%s\\n' '${AGENT}'` },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
          verdictContract: "legacy",
        });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("no artifact");
      }
    );
  });
});

describe("codex review MCP integration", () => {
  test("exit zero with a valid MCP success and no file publishes one successful review", async () => {
    const run = await syntheticCodexReview({
      maxIncompleteRetries: 0,
      codexBin: mcpBin([mcpCall(1, "set_verdict", { state: "success", reason: "clean" })]),
    });
    expect(run.result.status).toBe("posted");
    expect(run.reviews).toBe(1);
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
    if (run.persisted[0]?.kind !== "markdown") return;
    expect(run.persisted[0].markdown).toContain("<!-- jumi-check: success");
    expect(run.persisted[0].record?.state).toBe("success");
    expect(run.statuses.map((s) => s.state)).toEqual(["pending", "success"]);
  });

  test("a located risk finding with an MCP failure verdict publishes the failing review", async () => {
    const run = await syntheticCodexReview({
      maxIncompleteRetries: 0,
      codexBin: mcpBin([
        mcpCall(1, "add_finding", {
          path: "src/demo.ts",
          line: 1,
          severity: "risk",
          title: "unguarded deref",
          body: "Guard it.",
        }),
        mcpCall(2, "set_verdict", { state: "failure", reason: "blocking risk stands" }),
      ]),
    });
    expect(run.result.status).toBe("posted");
    // One inline batch plus the top-level body: the finding and the failing
    // review both reach the forge instead of `no artifact`.
    expect(run.reviews).toBe(2);
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
    if (run.persisted[0]?.kind !== "markdown") return;
    expect(run.persisted[0].markdown).toContain("src/demo.ts:1:");
    expect(run.persisted[0].markdown).toContain("<!-- jumi-check: failure; blocking risk stands -->");
    expect(run.persisted[0].record?.state).toBe("failure");
    expect(run.statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
  });

  test("exit zero with no MCP verdict stays incomplete with no publication", async () => {
    const run = await syntheticCodexReview({
      maxIncompleteRetries: 0,
      codexBin: mcpBin([]),
    });
    expect(run.result).toEqual({ status: "skipped", reason: "Incomplete review: no check verdict" });
    expect(run.reviews).toBe(0);
    expect(run.persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no check verdict" }]);
    expect(run.statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
  });

  test("file-only output in required mode stays incomplete", async () => {
    const run = await syntheticCodexReview({
      maxIncompleteRetries: 0,
      codexBin: mcpBin([`printf 'Looks good\\n<!-- jumi-check: success -->\\n' > "${REVIEW_ARTIFACT}"`]),
    });
    expect(run.result).toEqual({ status: "skipped", reason: "Incomplete review: no check verdict" });
    expect(run.reviews).toBe(0);
    expect(run.persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no check verdict" }]);
    expect(run.comments.some((body) => body.includes("Looks good"))).toBe(false);
  });

  test("a finding without a verdict follows the bounded retry policy then fails closed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-codex-retry-"));
    try {
      let spawns = 0;
      await withFakeBins(
        {
          codex: mcpBin([
            mcpCall(1, "add_finding", {
              path: "src/demo.ts",
              line: 1,
              severity: "risk",
              title: "unguarded deref",
              body: "Guard it.",
            }),
            `SPAWNS="$PWD/spawns.log"; [ -f "$SPAWNS" ] || : > "$SPAWNS"; printf 'spawn\\n' >> "$SPAWNS"`,
          ]),
        },
        async ({ home }) => {
          const persisted: PersistReviewResult[] = [];
          const result = (await reviewPullRequest({
            owner: "kirmanak",
            repo: "demo",
            prNumber: 7,
            model: "gpt-6-sol",
            chain: CODEX_CHAIN,
            workspace,
            home,
            giteaUrl: "https://gitea.kirmanak.stream",
            giteaToken: "bot-token",
            botUsername: "jumi",
            workspacePreparer: async () => undefined,
            logger: () => undefined,
            api: makeApi({
              getPR: async () => makePR({ head: { ...makePR().head, sha: "headsha" } }),
              getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
              createCommitStatus: async (_o, _r, _s, status) => status,
            }),
            gitRunner,
            persistResult: async (value) => {
              persisted.push(value);
            },
          })) as { status: string; reason?: string };
          expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no check verdict" });
          expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no check verdict" }]);
        }
      );
      const log = await readFile(join(workspace, "spawns.log"), "utf8");
      spawns = log.trim().split("\n").length;
      // One initial spawn plus the two bounded write-only retries.
      expect(spawns).toBe(3);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("explicit legacy mode publishes a valid fresh file", async () => {
    const run = await syntheticCodexReview({
      verdictContract: "legacy",
      maxIncompleteRetries: 0,
      codexBin: mcpBin([`printf 'Looks good\\n<!-- jumi-check: success -->\\n' > "${REVIEW_ARTIFACT}"`]),
    });
    expect(run.result.status).toBe("posted");
    expect(run.reviews).toBe(1);
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
  });
});

describe("codex review retry resume", () => {
  const THREAD_LINE = '{"type":"thread.started","thread_id":"thread-9"}';
  const RISK_FINDING = {
    path: "src/demo.ts",
    line: 1,
    severity: "risk",
    title: "unguarded deref",
    body: "Guard it.",
  };

  /**
   * Stub Codex child with a same-job session store: the first spawn writes a
   * rollout file and snapshots its config; the resume spawn fails loudly with
   * `no rollout found` unless the first spawn's session file survived in the
   * same CODEX_HOME. Spawn argv and homes are logged into the workspace.
   */
  function sessionMcpBin(first: string[], resume: string[]): string {
    return `#!/bin/sh
printf 'codex %s\\n' "$*" >> "$PWD/codex-args.log"
printf '%s\\n' "$CODEX_HOME" >> "$PWD/codex-homes.log"
${MCP_PREAMBLE}
SESSION="$CODEX_HOME/sessions/2026/11/25/rollout-thread-9.jsonl"
case " $* " in
  *" resume "*)
    if [ ! -f "$SESSION" ]; then printf 'no rollout found\\n' >&2; exit 1; fi
    cp "$CODEX_HOME/config.toml" "$PWD/config-resume.toml"
    ${resume.join("\n")}
    ;;
  *)
    mkdir -p "$CODEX_HOME/sessions/2026/11/25"
    printf '{"thread":"thread-9"}\\n' > "$SESSION"
    cp "$CODEX_HOME/config.toml" "$PWD/config-first.toml"
    ${first.join("\n")}
    ;;
esac
printf '%s\\n' '${THREAD_LINE}'
exit 0
`;
  }

  async function readLines(path: string): Promise<string[]> {
    try {
      return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async function runSessionReview(codexBin: string): Promise<{
    workspace: string;
    status: unknown;
    reviews: number;
    jobDirGoneAfterReview: boolean;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-codex-resume-"));
    let status: unknown;
    let reviews = 0;
    let jobDirGoneAfterReview = false;
    await withFakeBins({ codex: codexBin }, async ({ home }) => {
      const result = (await reviewPullRequest({
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        model: "gpt-6-sol",
        chain: CODEX_CHAIN,
        workspace,
        home,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        logger: () => undefined,
        api: makeApi({
          getPR: async () => makePR({ head: { ...makePR().head, sha: "headsha" } }),
          getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
          createPullReview: async () => {
            reviews++;
            return { id: reviews };
          },
          createCommitStatus: async (_o, _r, _s, cstatus) => cstatus,
        }),
        gitRunner,
        persistResult: async () => undefined,
      })) as { status: string; reason?: string };
      status = result;
      // Before the harness tears down: the review's own finally must have
      // removed the retained home with the rest of the harness temp.
      jobDirGoneAfterReview = !(await Bun.file(codexJobDir(workspace)).exists());
    });
    return { workspace, status, reviews, jobDirGoneAfterReview };
  }

  test("failure verdict with no findings retries with resume in the same session store", async () => {
    const bin = sessionMcpBin(
      [mcpCall(1, "set_verdict", { state: "failure", reason: "blocking risk stands" })],
      [
        mcpCall(2, "add_finding", RISK_FINDING),
        mcpCall(3, "set_verdict", { state: "failure", reason: "blocking risk stands" }),
      ]
    );
    const { workspace, status, reviews, jobDirGoneAfterReview } = await runSessionReview(bin);
    try {
      expect(status).toMatchObject({ status: "posted" });
      expect(reviews).toBeGreaterThanOrEqual(1);
      const args = await readLines(join(workspace, "codex-args.log"));
      expect(args).toHaveLength(2);
      expect(args[1]).toContain("resume thread-9");
      // The resume spawn saw the first spawn's session file in the same home.
      const homes = await readLines(join(workspace, "codex-homes.log"));
      expect(homes).toHaveLength(2);
      expect(homes[0]).toBeTruthy();
      expect(homes[1]).toBe(homes[0]);
      // Per-spawn rebuild: one review-MCP entry in each spawn's config.
      for (const name of ["config-first.toml", "config-resume.toml"]) {
        const parsed = Bun.TOML.parse(await readFile(join(workspace, name), "utf8")) as {
          mcp_servers?: Record<string, unknown>;
        };
        expect(Object.keys(parsed.mcp_servers ?? {})).toEqual(["jumi-review"]);
      }
      // Job end removed the retained home with the rest of the harness temp.
      expect(jobDirGoneAfterReview).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("no verdict retries with resume in the same session store", async () => {
    const bin = sessionMcpBin(
      [mcpCall(1, "add_finding", RISK_FINDING)],
      [mcpCall(2, "set_verdict", { state: "failure", reason: "blocking risk stands" })]
    );
    const { workspace, status, reviews, jobDirGoneAfterReview } = await runSessionReview(bin);
    try {
      expect(status).toMatchObject({ status: "posted" });
      expect(reviews).toBeGreaterThanOrEqual(1);
      const args = await readLines(join(workspace, "codex-args.log"));
      expect(args).toHaveLength(2);
      expect(args[1]).toContain("resume thread-9");
      const homes = await readLines(join(workspace, "codex-homes.log"));
      expect(homes).toHaveLength(2);
      expect(homes[1]).toBe(homes[0]);
      expect(jobDirGoneAfterReview).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
