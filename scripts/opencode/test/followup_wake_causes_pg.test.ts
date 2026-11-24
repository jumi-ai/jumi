import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { FollowUpWakeCauseInput } from "../src/followup_wake_causes.ts";
import { payloadDigestForWakeCause, webhookWakeDeliveryFallback } from "../src/followup_wake_causes.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function payload(generation: number, marker = "a"): Record<string, unknown> {
  return {
    issueNumber: 12,
    title: "Fix",
    body: `body-${marker}`,
    htmlUrl: "https://example.test/o/r/issues/12",
    issueUpdatedAt: "2026-05-23T00:00:00Z",
    defaultBranch: "main",
    cloneUrl: "https://example.test/o/r.git",
    action: "created",
    trigger: { event: "issue_comment", sender: "alice" },
    generation,
  };
}

function input(overrides: Partial<FollowUpWakeCauseInput> = {}): FollowUpWakeCauseInput {
  return {
    jobKey: "follow-up:o/r#12:head-1",
    owner: "o",
    repo: "r",
    issueNumber: 12,
    prNumber: 100,
    headSha: "head-1",
    delivery: "delivery-1",
    payload: payload(0),
    ...overrides,
  };
}

function asRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

describePg("follow-up wake causes against real postgres", () => {
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
    await sql.unsafe(`TRUNCATE follow_up_wake_causes RESTART IDENTITY`);
    await store.migrate();
  });

  test("schema check lists the table and migrate twice is a no-op", async () => {
    await store.migrate();
    await store.migrate();
    const tables = asRows<{ name: unknown }>(
      await sql.unsafe(`SELECT tablename AS name FROM pg_tables WHERE tablename = 'follow_up_wake_causes'`)
    );
    expect(tables.length).toBe(1);
    const columns = asRows<{ name: unknown }>(
      await sql.unsafe(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_name = 'follow_up_wake_causes'`
      )
    );
    const names = new Set(columns.map((row) => String(row.name)));
    for (const column of [
      "job_key",
      "owner",
      "repo",
      "issue_number",
      "pr_number",
      "head_sha",
      "cause_id",
      "delivery",
      "payload",
      "state",
      "park_reason",
      "promoted_job_id",
      "created_at",
      "settled_at",
    ]) {
      expect(names.has(column)).toBe(true);
    }
    await store.assertSchema?.();
  });

  test("record round-trips the exact payload and dedupes in pending state", async () => {
    const body = payload(0);
    expect(await store.wakeCauses.record(input({ payload: body }))).toBe("recorded");
    expect(await store.wakeCauses.record(input({ payload: body }))).toBe("duplicate");
    const cause = await store.wakeCauses.get("follow-up:o/r#12:head-1", "delivery:delivery-1");
    expect(cause?.payload).toEqual(body);
    expect(cause?.state).toBe("pending");
  });

  test("duplicate in promoted and parked states", async () => {
    expect(await store.wakeCauses.record(input({ jobKey: "promote-key", delivery: "p" }))).toBe("recorded");
    const pending = await store.wakeCauses.peekOldestPending("promote-key");
    expect(await store.wakeCauses.markPromoted(pending?.id ?? 0, 101)).toBe(true);
    expect(await store.wakeCauses.record(input({ jobKey: "promote-key", delivery: "p" }))).toBe("duplicate");

    expect(await store.wakeCauses.record(input({ jobKey: "park-key", delivery: "q" }))).toBe("recorded");
    expect(await store.wakeCauses.parkPendingForKey("park-key", "stale")).toBe(1);
    expect(await store.wakeCauses.record(input({ jobKey: "park-key", delivery: "q" }))).toBe("duplicate");
    const parked = await store.wakeCauses.list("park-key", "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("stale");
  });

  test("explicit, delivery, and digest identities with key-order irrelevance", async () => {
    expect(await store.wakeCauses.record(input({ jobKey: "explicit", causeId: "src:9", delivery: "" }))).toBe(
      "recorded"
    );
    expect(await store.wakeCauses.record(input({ jobKey: "explicit", causeId: " src:9 ", delivery: "" }))).toBe(
      "duplicate"
    );
    expect(await store.wakeCauses.get("explicit", "src:9")).toBeDefined();

    const digest = `payload-sha256:${payloadDigestForWakeCause(payload(0))}`;
    expect(await store.wakeCauses.record(input({ jobKey: "digest", delivery: "", payload: payload(0) }))).toBe(
      "recorded"
    );
    expect(await store.wakeCauses.get("digest", digest)).toBeDefined();
    // Same payload and generation replays; key order does not matter.
    const first = payload(0);
    const reorderedEntries = Object.entries(first).reverse();
    const reordered: Record<string, unknown> = Object.fromEntries(reorderedEntries);
    reordered.trigger = Object.fromEntries(Object.entries(first.trigger as Record<string, unknown>).reverse());
    expect(await store.wakeCauses.record(input({ jobKey: "digest", delivery: "", payload: reordered }))).toBe(
      "duplicate"
    );
    // Changed payload and newly authorized generation are distinct.
    expect(await store.wakeCauses.record(input({ jobKey: "digest", delivery: "", payload: payload(0, "b") }))).toBe(
      "recorded"
    );
    expect(await store.wakeCauses.record(input({ jobKey: "digest", delivery: "", payload: payload(1) }))).toBe(
      "recorded"
    );

    const fallback = webhookWakeDeliveryFallback("issue_comment", "raw-body-1");
    expect(await store.wakeCauses.record(input({ jobKey: "hook", delivery: fallback }))).toBe("recorded");
    expect(await store.wakeCauses.record(input({ jobKey: "hook", delivery: fallback }))).toBe("duplicate");
  });

  test("oldest-first peek; promotion keeps identity and payload", async () => {
    await store.wakeCauses.record(input({ delivery: "second" }));
    await store.wakeCauses.record(input({ delivery: "first" }));
    const peeked = await store.wakeCauses.peekOldestPending("follow-up:o/r#12:head-1");
    expect(peeked?.causeId).toBe("delivery:second");
    const before = await store.wakeCauses.get("follow-up:o/r#12:head-1", "delivery:second");
    expect(await store.wakeCauses.markPromoted(peeked?.id ?? 0, 202)).toBe(true);
    expect(await store.wakeCauses.record(input({ delivery: "second" }))).toBe("duplicate");
    const after = await store.wakeCauses.get("follow-up:o/r#12:head-1", "delivery:second");
    expect(after?.state).toBe("promoted");
    expect(after?.promotedJobId).toBe(202);
    expect(after?.payload).toEqual(before?.payload);
    expect(await store.wakeCauses.countPending("follow-up:o/r#12:head-1")).toBe(1);
  });

  test("generation-filtered park leaves later valid causes pending", async () => {
    await store.wakeCauses.record(input({ jobKey: "gen", delivery: "old", payload: payload(0) }));
    await store.wakeCauses.record(input({ jobKey: "gen", delivery: "current", payload: payload(2) }));
    await store.wakeCauses.record(input({ jobKey: "gen", delivery: "newer", payload: payload(5) }));
    expect(await store.wakeCauses.parkPendingForKey("gen", "superseded", { generation: 2 })).toBe(1);
    expect((await store.wakeCauses.get("gen", "delivery:old"))?.state).toBe("parked");
    expect((await store.wakeCauses.get("gen", "delivery:current"))?.state).toBe("pending");
    expect((await store.wakeCauses.get("gen", "delivery:newer"))?.state).toBe("pending");

    await store.wakeCauses.record(
      input({ jobKey: "issue-park", owner: "o", repo: "r", issueNumber: 12, delivery: "stale", payload: payload(0) })
    );
    await store.wakeCauses.record(
      input({ jobKey: "issue-park", owner: "o", repo: "r", issueNumber: 12, delivery: "fresh", payload: payload(4) })
    );
    expect(await store.wakeCauses.parkPendingForIssue("o", "r", 12, "superseded", { generation: 4 })).toBe(1);
    expect((await store.wakeCauses.get("issue-park", "delivery:stale"))?.state).toBe("parked");
    expect((await store.wakeCauses.get("issue-park", "delivery:fresh"))?.state).toBe("pending");
  });

  test("no row is ever deleted: 1000 records all persist with no cap", async () => {
    for (let i = 0; i < 1000; i++) {
      const outcome = await store.wakeCauses.record(input({ delivery: `bulk-${i}` }));
      expect(outcome).toBe("recorded");
    }
    expect(await store.wakeCauses.countPending("follow-up:o/r#12:head-1")).toBe(1000);
    expect((await store.wakeCauses.list("follow-up:o/r#12:head-1")).length).toBe(1000);
  });

  test("concurrent record of the same cause persists once", async () => {
    const sqlA = openTestSqlClient(pgDatabaseUrl);
    const sqlB = openTestSqlClient(pgDatabaseUrl);
    try {
      const storeA = new PgReviewJobStore(sqlA);
      const storeB = new PgReviewJobStore(sqlB);
      await storeA.migrate();
      const body = input({ jobKey: "race-key", delivery: "race" });
      const [ra, rb] = await Promise.all([storeA.wakeCauses.record(body), storeB.wakeCauses.record(body)]);
      expect([ra, rb].sort()).toEqual(["duplicate", "recorded"]);
      expect(await store.wakeCauses.countPending("race-key")).toBe(1);
    } finally {
      await sqlA.close?.();
      await sqlB.close?.();
    }
  });

  test("concurrent peek under row lock cannot both promote the same cause", async () => {
    const sqlA = openTestSqlClient(pgDatabaseUrl);
    const sqlB = openTestSqlClient(pgDatabaseUrl);
    try {
      const storeA = new PgReviewJobStore(sqlA);
      const storeB = new PgReviewJobStore(sqlB);
      await storeA.migrate();
      await storeA.wakeCauses.record(input({ jobKey: "promote-race", delivery: "race" }));
      const [ra, rb] = await Promise.all([
        sqlA.begin(async (tx) => {
          const pending = await storeA.wakeCauses.peekOldestPending("promote-race", tx);
          if (!pending) return "none";
          await tx.unsafe("SELECT pg_sleep(0.2)");
          return (await storeA.wakeCauses.markPromoted(pending.id, 111, tx)) ? "promoted" : "missed";
        }),
        sqlB.begin(async (tx) => {
          await tx.unsafe("SELECT pg_sleep(0.05)");
          const pending = await storeB.wakeCauses.peekOldestPending("promote-race", tx);
          if (!pending) return "none";
          return (await storeB.wakeCauses.markPromoted(pending.id, 222, tx)) ? "promoted" : "missed";
        }),
      ]);
      expect([ra, rb].sort()).toEqual(["none", "promoted"]);
      expect(await store.wakeCauses.countPending("promote-race")).toBe(0);
      const parked = await store.wakeCauses.list("promote-race");
      expect(parked).toHaveLength(1);
      expect(parked[0]?.state).toBe("promoted");
    } finally {
      await sqlA.close?.();
      await sqlB.close?.();
    }
  });
});
