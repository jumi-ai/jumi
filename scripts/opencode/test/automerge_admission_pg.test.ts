import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { drainAutomergeReconcile } from "../src/automerge_reconcile_drain.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeBranch, makeComment, makeConfig, makePR, makeUser } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function apiWith(order: string[], opts: { prLabels: Array<string | { name?: string }> }) {
  return {
    getRepo: async () => {
      order.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
      };
    },
    getPR: async (_owner: string, _repo: string, index: number) => {
      order.push("getPR");
      return makePR({
        number: index,
        user: makeUser({ login: "jumi" }),
        head: makeBranch({ ref: "jumi/issue-12-foo", sha: "headsha" }),
        title: "Jumi: fix the thing",
        body: "Fixes #12",
        labels: opts.prLabels as never,
      });
    },
    getRepoFile: async () => {
      order.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    },
    cancelAutoMerge: async () => {
      order.push("cancelAutoMerge");
      return true;
    },
    getBranch: async () => {
      order.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: ["jumi/opencode-review"] };
    },
    scheduleAutoMerge: async () => {
      order.push("scheduleAutoMerge");
    },
    getCollaboratorPermission: async () => ({ permission: "write" }),
    createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => {
      order.push("createIssueComment");
      return makeComment({ body });
    },
    updateIssueComment: async (_owner: string, _repo: string, _id: number, body: string) => {
      order.push("updateIssueComment");
      return makeComment({ body });
    },
    getPRFiles: async () => {
      order.push("getPRFiles");
      return [];
    },
    listIssueTimeline: async () => {
      order.push("listIssueTimeline");
      return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    },
    findStickyIssueComment: async () => undefined,
    getIssue: async () => ({ labels: [], number: 12 }),
  };
}

function labelBody(action: string, label: string) {
  return new TextEncoder().encode(
    JSON.stringify({
      action,
      repository: {
        full_name: "kirmanak/demo",
        default_branch: "main",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
      },
      label: { name: label },
      sender: { login: "alice" },
      pull_request: { number: 3 },
    })
  );
}

function policy() {
  return {
    giteaUrl: "https://gitea.example.test",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [] as string[],
    botUsername: "jumi",
    forgeKind: "gitea",
  };
}

async function generationOf(sql: SqlClient): Promise<number | null> {
  const result = (await sql.unsafe(
    `SELECT generation FROM automerge_reconcile WHERE owner = 'kirmanak' AND repo = 'demo' AND pr_number = 3`
  )) as unknown as Array<{ generation: unknown }> | { rows?: Array<{ generation: unknown }> };
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  if (rows.length === 0) return null;
  return Number(rows[0]?.generation);
}

describePg("automerge admission against real postgres", () => {
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

  test("row before first forge read; cancel defers; the tick cancels; replay is a no-op", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const order: string[] = [];
    const seen: string[] = [];
    const inner = store.automergeReconcile;
    const watched = {
      request: (async (...args: [string, string, number, string, number]) => {
        seen.push("request");
        return inner.request(...args);
      }) as typeof inner.request,
      settle: inner.settle.bind(inner),
      claimDue: inner.claimDue.bind(inner),
      renew: inner.renew.bind(inner),
      complete: inner.complete.bind(inner),
      fail: inner.fail.bind(inner),
      block: inner.block.bind(inner),
      listExhausted: inner.listExhausted.bind(inner),
    };
    const deps = {
      queue: { enqueue: async () => ({ queued: true, key: "k" }) },
      api: apiWith(order, { prLabels: [] }),
      automergeReconcile: watched,
    } as never;
    const res = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "pg-d1",
      policy() as never,
      deps
    );
    expect(res.status).toBe(202);
    expect(String((await res.json()).reason)).toContain("cancel-deferred");
    expect([...seen, ...order][0]).toBe("request");
    expect(order).not.toContain("cancelAutoMerge");
    expect(typeof (await generationOf(sql))).toBe("number");
    // The existing tick performs the cancellation.
    const summary = await drainAutomergeReconcile(
      store,
      apiWith(order, { prLabels: ["no-automerge"] }) as never,
      makeConfig(),
      () => undefined
    );
    expect(summary.completed).toBe(1);
    expect(order.filter((entry) => entry === "cancelAutoMerge")).toHaveLength(1);
    expect(await generationOf(sql)).toBeNull();
    // Same-delivery replay after completion: no new row, effect, or bump.
    const replay = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "pg-d1",
      policy() as never,
      deps
    );
    expect(replay.status).toBe(202);
    expect(String((await replay.json()).reason)).toContain("duplicate");
    expect(await generationOf(sql)).toBeNull();
    expect(order.filter((entry) => entry === "cancelAutoMerge")).toHaveLength(1);
  });

  test("distinct delivery bumps; a stale settle of the older generation is harmless", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const order: string[] = [];
    const deps = {
      queue: { enqueue: async () => ({ queued: true, key: "k" }) },
      api: apiWith(order, { prLabels: [] }),
      automergeReconcile: store.automergeReconcile,
    } as never;
    await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "pg-e1",
      policy() as never,
      deps
    );
    const first = await generationOf(sql);
    expect(typeof first).toBe("number");
    await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "pg-e2",
      policy() as never,
      deps
    );
    const second = await generationOf(sql);
    expect(second).toBe((first as number) + 1);
    expect(await store.automergeReconcile.settle("kirmanak", "demo", 3, first as number)).toBe("stale");
    expect(await generationOf(sql)).toBe(second);
  });

  test("fresh re-enable settles its admission generation", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const order: string[] = [];
    const deps = {
      queue: { enqueue: async () => ({ queued: true, key: "k" }) },
      api: apiWith(order, { prLabels: ["automerge"] }),
      automergeReconcile: store.automergeReconcile,
    } as never;
    const res = await handleWorkerWebhookEvent(
      labelBody("labeled", "automerge"),
      "pull_request",
      null,
      "pg-s1",
      policy() as never,
      deps
    );
    expect(res.status).toBe(202);
    expect(String((await res.json()).reason)).toContain("scheduled");
    expect(await generationOf(sql)).toBeNull();
  });
});
