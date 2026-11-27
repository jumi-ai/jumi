import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistReviewResult, ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { MemoryReviewJobStore, PgReviewJobStore, REVIEW_JOBS_SCHEMA_SQL } from "../src/review_jobs.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { emptyCiMethods, makeComment, makeFile, makeJob, makePR, makeRepo } from "./fixtures.ts";

const PATCH = ["@@ -1,3 +1,5 @@", " context", "-old", "+new line two", "+new line three", " context", " tail"].join(
  "\n"
);

function makeStore() {
  return new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
}

describe("ReviewVerdictStore.toRecord", () => {
  test("records verdict, located/unlocated findings, and counts", () => {
    const store = makeStore();
    expect(
      store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." }).ok
    ).toBe(true);
    expect(store.addFinding({ severity: "question", title: "why?", body: "explain" }).ok).toBe(true);
    expect(store.addFinding({ path: "src/a.ts", line: 3, severity: "suggestion", body: "nit" }).ok).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    expect(store.toRecord()).toEqual({
      version: 1,
      state: "failure",
      reason: "blocking",
      findings: [
        { id: "f1", path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." },
        { id: "f2", severity: "question", title: "why?", body: "explain" },
        { id: "f3", path: "src/a.ts", line: 3, severity: "suggestion", title: "", body: "nit" },
      ],
      counts: { bug: 1, risk: 0, question: 1, suggestion: 1, maintainerQuestion: 0 },
    });
  });

  test("no verdict is incomplete with no reason", () => {
    const store = makeStore();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "risk", body: "race" }).ok).toBe(true);
    expect(store.toRecord()).toEqual({
      version: 1,
      state: "incomplete",
      findings: [{ id: "f1", path: "src/a.ts", line: 2, severity: "risk", title: "", body: "race" }],
      counts: { bug: 0, risk: 1, question: 0, suggestion: 0, maintainerQuestion: 0 },
    });
  });

  test("success without findings carries no reason key", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.toRecord()).toEqual({
      version: 1,
      state: "success",
      findings: [],
      counts: { bug: 0, risk: 0, question: 0, suggestion: 0, maintainerQuestion: 0 },
    });
  });

  test("reason is stored unsanitized while the trailer is sanitized", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success", reason: "bump a -> b" }).ok).toBe(true);
    expect(store.toRecord().reason).toBe("bump a -> b");
    expect(store.toMarkdown()).toBe("<!-- jumi-check: success; bump a → b -->");
  });
});

describe("ReviewVerdictStore.toMarkdown byte stability", () => {
  test("fixed stores render byte-identical markdown", () => {
    const store = makeStore();
    expect(
      store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." }).ok
    ).toBe(true);
    expect(store.addFinding({ severity: "question", title: "why?", body: "explain" }).ok).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    expect(store.toMarkdown()).toBe(
      "src/a.ts:2: 🔴 bug: null deref Guard it.\n❓ q: why? explain\n<!-- jumi-check: failure; blocking -->"
    );

    const empty = makeStore();
    expect(empty.toMarkdown()).toBe("<!-- jumi-check: failure; Incomplete review: no verdict -->");

    const success = makeStore();
    expect(success.setVerdict({ state: "success" }).ok).toBe(true);
    expect(success.toMarkdown()).toBe("<!-- jumi-check: success -->");
  });
});

describe("MemoryReviewJobStore result_json", () => {
  test("saveResult round-trips the record and clears it on skip/error", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(leased).toBeDefined();
    const record = {
      version: 1 as const,
      state: "failure" as const,
      reason: "blocking",
      findings: [{ id: "f1", path: "src/a.ts", line: 2, severity: "bug" as const, title: "t", body: "b" }],
      counts: { bug: 1, risk: 0, question: 0, suggestion: 0 },
    };
    await store.saveResult(leased!.id, "engine-1", { kind: "markdown", markdown: "md", record });
    expect(store.rows[0]?.resultJson).toEqual(record);

    await store.saveResult(leased!.id, "engine-1", { kind: "skip", reason: "late" });
    expect("resultJson" in (store.rows[0] ?? {})).toBe(false);

    await store.saveResult(leased!.id, "engine-1", { kind: "markdown", markdown: "md", record });
    expect(store.rows[0]?.resultJson).toEqual(record);
    await store.saveResult(leased!.id, "engine-1", { kind: "error", error: "boom" });
    expect("resultJson" in (store.rows[0] ?? {})).toBe(false);
  });

  test("markdown without a record leaves the field absent", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    await store.saveResult(leased!.id, "engine-1", { kind: "markdown", markdown: "md" });
    expect("resultJson" in (store.rows[0] ?? {})).toBe(false);
  });
});

describe("PgReviewJobStore result_json statements", () => {
  test("migration adds a nullable jsonb column", () => {
    expect(REVIEW_JOBS_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS result_json JSONB");
  });

  test("markdown save writes result_json, skip/error clear it", async () => {
    const seen: Array<{ query: string; params?: unknown[] }> = [];
    const sql = {
      async unsafe(query: string, params?: unknown[]) {
        seen.push({ query, params });
        return [{ id: 1 }];
      },
      async begin<T>(fn: (tx: typeof sql) => Promise<T>) {
        return fn(sql);
      },
    } as unknown as SqlClient;
    const store = new PgReviewJobStore(sql);
    const record = {
      version: 1 as const,
      state: "success" as const,
      findings: [],
      counts: { bug: 0, risk: 0, question: 0, suggestion: 0 },
    };
    await store.saveResult(1, "engine-1", { kind: "markdown", markdown: "md", runner: "r", record });
    const markdownQuery = seen.at(-1)!;
    expect(markdownQuery.query).toContain("result_json");
    expect(markdownQuery.params).toContain(JSON.stringify(record));
    // Additive Pi stamp columns ride the same save without changing the
    // result_json contract: unknown usage stays NULL, never zero.
    expect(markdownQuery.query).toContain("pi_profile");

    await store.saveResult(1, "engine-1", { kind: "skip", reason: "late" });
    expect(seen.at(-1)!.query).toContain("result_json = NULL");

    await store.saveResult(1, "engine-1", { kind: "error", error: "boom" });
    expect(seen.at(-1)!.query).toContain("result_json = NULL");
  });
});

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

describe("publishMcpVerdict record persistence", () => {
  async function runMcpReview(noCiNote?: string): Promise<PersistReviewResult[]> {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-record-"));
    try {
      const persisted: PersistReviewResult[] = [];
      const gitRunner = async (args: string[]) => {
        if (args[0] === "rev-parse") return "headsha";
        if (args[0] === "status") return "?? JUMI_REVIEW.md";
        if (args[0] === "ls-files") return "";
        if (args[0] === "checkout") return "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      await reviewPullRequest({
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
        }),
        gitRunner,
        persistResult: async (value) => {
          persisted.push(value);
        },
        ...(noCiNote ? { noCiNote } : {}),
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { reviewMcp?: { url: string; token: string } }).reviewMcp;
          expect(mcp?.url).toBeTruthy();
          const added = await probeReviewMcpServer(mcp!.url, mcp!.token, "add_finding", {
            path: "src/demo.ts",
            line: 1,
            severity: "bug",
            title: "null deref",
            body: "Guard it.",
          });
          expect(added.ok).toBe(true);
          const verdict = await probeReviewMcpServer(mcp!.url, mcp!.token, "set_verdict", {
            state: "failure",
            reason: "blocking",
          });
          expect(verdict.ok).toBe(true);
          return { status: "ok" };
        },
      });
      return persisted;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  test("unmodified MCP verdict persists the record", async () => {
    const persisted = await runMcpReview();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.kind).toBe("markdown");
    if (persisted[0]?.kind !== "markdown") return;
    expect(persisted[0].record).toEqual({
      version: 1,
      state: "failure",
      reason: "blocking",
      findings: [{ id: "f1", path: "src/demo.ts", line: 1, severity: "bug", title: "null deref", body: "Guard it." }],
      counts: { bug: 1, risk: 0, question: 0, suggestion: 0, maintainerQuestion: 0 },
    });
  });

  test("modified markdown (noCiNote) omits the record", async () => {
    const persisted = await runMcpReview("CI was unavailable.");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.kind).toBe("markdown");
    if (persisted[0]?.kind !== "markdown") return;
    expect(persisted[0].markdown.startsWith("CI was unavailable.")).toBe(true);
    expect("record" in persisted[0]).toBe(false);
  });
});
