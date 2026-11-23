import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ReviewApi } from "../src/review.ts";
import { PgReviewJobStore, RECLAIM_PUBLISH_MAX_FAILURES } from "../src/review_jobs.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const GONE_404 = "GitHub API GET https://api.github.com/repos/kirmanak/demo/installation → 404: Not Found";
const TRANSIENT_502 = "Gitea API GET https://gitea.example.com/api/v1/repos/kirmanak/demo/pulls/7 → 502: Bad Gateway";

describePg("PgReviewJobStore reclaim fallback and kick gate (#810)", () => {
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
    await sql.unsafe(`TRUNCATE review_jobs, review_kicks RESTART IDENTITY`);
    await store.migrate();
  });

  test("gone publish error settles a max-attempts row to failed in one pass", async () => {
    await store.enqueue(makeJob({ delivery: "d-pg-404" }));
    const leased = await store.lease("dead-engine", 1, new Date(Date.now() - 60_000));
    if (!leased) throw new Error("expected a leased job");
    const api = makeReviewApi({
      getPR: async () => {
        throw new Error(GONE_404);
      },
    }) as ReviewApi;

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    const row = await store.get(leased.id);
    expect(row?.state).toBe("failed");
    expect(row?.resultReason).toContain("404");

    const summary = await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);
    expect(summary).toEqual({ requeued: 0, published: 0 });
    expect((await store.get(leased.id))?.state).toBe("failed");
  });

  test("transient publish errors settle failed once the retry bound is reached", async () => {
    await store.enqueue(makeJob({ delivery: "d-pg-bound" }));
    const leased = await store.lease("dead-engine", 1, new Date(Date.now() - 60_000));
    if (!leased) throw new Error("expected a leased job");
    await store.saveResult(leased.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const api = makeReviewApi({
      createPullReview: async () => {
        throw new Error(TRANSIENT_502);
      },
      createIssueComment: async () => {
        throw new Error(TRANSIENT_502);
      },
    }) as ReviewApi;

    for (let n = 1; n < RECLAIM_PUBLISH_MAX_FAILURES; n++) {
      await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 2 }), () => undefined);
      const row = await store.get(leased.id);
      expect(row?.state).toBe("leased");
      expect(row?.reclaimPublishFailures ?? 0).toBe(n);
    }
    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 2 }), () => undefined);
    expect((await store.get(leased.id))?.state).toBe("failed");
  });

  test("merged-PR kick refuses without a job and logs the refusal", async () => {
    await store.enqueue(makeJob({ delivery: "d-pg-kick" }));
    const leased = await store.lease("worker", 60_000);
    if (!leased) throw new Error("expected a leased job");
    await store.saveResult(leased.id, "worker", { kind: "error", error: "boom" });
    await store.markPublished(leased.id, "worker", { state: "failed", reason: "boom" });

    const outcome = await store.requeueKick({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      kick: "boom",
      actor: "operator",
      idempotencyKey: "pg-kick-merged",
      delivery: "board-kick:test",
      forge: { state: "closed", merged: true },
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejection");
    expect(outcome.code).toBe("not-kickable");
    const logged = await store.getKickByIdempotencyKey("pg-kick-merged");
    expect(logged?.result).toBe("not-kickable");
    expect(logged?.terminalJobId).toBe(leased.id);
    const rows = await store.listRowsForNumber("kirmanak", "demo", 7, 10);
    expect(rows.every((row) => row.state !== "queued")).toBe(true);
  });

  test("canonical repo retargets the new row", async () => {
    await store.enqueue(makeJob({ delivery: "d-pg-move" }));
    const leased = await store.lease("worker", 60_000);
    if (!leased) throw new Error("expected a leased job");
    await store.saveResult(leased.id, "worker", { kind: "error", error: "boom" });
    await store.markPublished(leased.id, "worker", { state: "failed", reason: "boom" });

    const outcome = await store.requeueKick({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      kick: "boom",
      actor: "operator",
      idempotencyKey: "pg-kick-moved",
      delivery: "board-kick:test",
      forge: { state: "open", merged: false, canonicalFullName: "jumi-ai/demo" },
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.job.owner).toBe("jumi-ai");
    expect(outcome.job.repo).toBe("demo");
  });
});
