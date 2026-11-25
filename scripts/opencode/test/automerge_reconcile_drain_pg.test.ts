import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { drainAutomergeReconcile } from "../src/automerge_reconcile_drain.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeBranch, makeConfig, makePR, makeUser } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function jumiPrLabels(labels: Array<string | { name?: string }>, overrides: Record<string, unknown> = {}) {
  return makePR({
    user: makeUser({ login: "jumi" }),
    head: makeBranch({ ref: "jumi/issue-12-foo", sha: "headsha" }),
    title: "Jumi: fix the thing",
    body: "Fixes #12",
    labels: labels as never,
    ...overrides,
  });
}

function drainApi(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api = {
    getRepo: async () => {
      calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
      };
    },
    getPR: async (_o: string, _r: string, index: number) => {
      calls.push("getPR");
      return jumiPrLabels(["no-automerge"], { number: index });
    },
    getRepoFile: async () => {
      calls.push("getRepoFile");
      return { found: true, content: "automerge: true\n" };
    },
    cancelAutoMerge: async () => {
      calls.push("cancelAutoMerge");
      return true;
    },
    findStickyIssueComment: async () => undefined,
    createIssueComment: async () => ({ id: 1 }),
    updateIssueComment: async () => undefined,
    getIssue: async () => {
      throw new Error("not used");
    },
    getCollaboratorPermission: async () => ({ permission: "write" }),
    ...overrides,
  };
  return { api, calls };
}

describePg("automerge reconcile drain against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE automerge_reconcile, automerge_reconcile_cause`);
  });

  test("cancel fails then the tick cancels and deletes the row after backoff", async () => {
    let calls = 0;
    const { api } = drainApi({
      cancelAutoMerge: async () => {
        calls += 1;
        if (calls === 1) throw new Error("forge exploded → 500: boom");
        return true;
      },
    });
    const nowMs = Date.now();
    await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-A", nowMs);
    const first = await drainAutomergeReconcile(store, api as never, makeConfig(), () => undefined);
    expect(first.retried).toBe(1);
    expect(first.completed).toBe(0);
    // In backoff: nothing due.
    const during = await drainAutomergeReconcile(store, api as never, makeConfig(), () => undefined);
    expect(during.claimed).toBe(0);
    // After backoff the tick cancels and deletes it.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const after = await drainAutomergeReconcile(store, api as never, makeConfig(), () => undefined);
    expect(after.completed).toBe(1);
    expect(calls).toBe(2);
    expect(await store.automergeReconcile.claimDue("peek", 60_000, 10, Date.now())).toEqual([]);
  });

  test("labels now say schedule: completed with no schedule and no cancel", async () => {
    const { api, calls } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels([], { number: index });
      },
      scheduleAutoMerge: async () => {
        calls.push("scheduleAutoMerge");
      },
    });
    await store.automergeReconcile.request("kirmanak", "demo", 9, "cause-A", Date.now());
    const summary = await drainAutomergeReconcile(store, api as never, makeConfig(), () => undefined);
    expect(summary.completed).toBe(1);
    expect(calls).not.toContain("scheduleAutoMerge");
    expect(calls).not.toContain("cancelAutoMerge");
  });
});
