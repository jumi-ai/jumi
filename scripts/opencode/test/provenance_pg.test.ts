import { describe, expect, test } from "bun:test";
import { PgProvenanceStore } from "../src/provenance.ts";
import { createBunSqlClient } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";

// Durable path: the same SQL runs against real Postgres, not an in-memory
// twin. Skipped without JUMI_TEST_DATABASE_URL so `bun test` stays green.
const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

test("postgres provenance suite is not silently skipped where CI requires it", () => {
  expect(pgRequired && databaseUrl === "").toBe(false);
});

const describePg = databaseUrl ? describe : describe.skip;

describePg("PgProvenanceStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgProvenanceStore;

  async function countProvenance(): Promise<number> {
    const result = (await sql.unsafe(`SELECT COUNT(*)::int AS n FROM pr_writer_provenance`)) as Array<{ n: unknown }>;
    const rows = Array.isArray(result) ? result : [];
    return Number(rows[0]?.n ?? 0);
  }

  // Fresh client per test proves restart recovery: rows survive a new store.
  function reopen(): PgProvenanceStore {
    return new PgProvenanceStore(sql);
  }

  // Bun's beforeAll/beforeEach are available, but keep setup inside the first
  // test's helpers so a missing URL never touches the driver.
  async function setup(): Promise<void> {
    if ((setup as { done?: boolean }).done) return;
    (setup as { done?: boolean }).done = true;
    sql = createBunSqlClient(databaseUrl);
    store = new PgProvenanceStore(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS pr_writer_provenance, pr_publication_intents`);
    await store.migrate();
  }

  async function reset(): Promise<void> {
    await setup();
    await sql.unsafe(`TRUNCATE pr_writer_provenance, pr_publication_intents RESTART IDENTITY`);
    await store.migrate();
    store = reopen();
  }

  test("migrate is idempotent and old heads stay unknown", async () => {
    await reset();
    await store.migrate();
    await store.migrate();
    expect((await store.lookupByHead("gitea", "kirmanak", "demo", "legacy")).status).toBe("unknown");
    expect(await countProvenance()).toBe(0);
  });

  test("publish-before-review stays pending across restarts, then known", async () => {
    await reset();
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 7,
      branch: "jumi/issue-12-a",
      jobId: 101,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      jobKind: "follow-up",
      delivery: "d101",
    });
    await store.noteIntentRunners(101, [{ type: "claude", model: "claude-opus-5", effort: "high" }], {
      type: "claude",
      model: "claude-opus-5",
      effort: "high",
    });
    // Restart: a new store on the same database still sees the intent.
    const restarted = reopen();
    const pending = await restarted.lookupForReview({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "head2",
      branch: "jumi/issue-12-a",
    });
    expect(pending.status).toBe("pending");
    expect(pending.contributors).toEqual([{ type: "claude", model: "claude-opus-5", effort: "high" }]);

    await restarted.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head2",
      contributors: [{ type: "opencode", model: "xai/grok-4.6", variant: "high" }],
      publisher: { type: "opencode", model: "xai/grok-4.6", variant: "high" },
      jobId: 101,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      delivery: "d101",
      jobKind: "follow-up",
    });
    const known = await reopen().lookupByHead("gitea", "kirmanak", "demo", "head2");
    expect(known.status).toBe("known");
    // No earlier failed runner here, so only the publisher is recorded.
    expect(known.contributors).toEqual([{ type: "opencode", model: "xai/grok-4.6", variant: "high" }]);
  });

  test("follow-up preserves earlier contributors on a new head", async () => {
    await reset();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 9,
      branch: "jumi/issue-12-a",
      headSha: "base1",
      contributors: [{ type: "claude", model: "claude-opus-5", effort: "high" }],
      publisher: { type: "claude", model: "claude-opus-5", effort: "high" },
      jobId: 201,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d201",
      jobKind: "implement",
    });
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 9,
      branch: "jumi/issue-12-a",
      headSha: "next2",
      contributors: [{ type: "opencode", model: "xai/grok-4.6", variant: "high" }],
      publisher: { type: "opencode", model: "xai/grok-4.6", variant: "high" },
      jobId: 202,
      jobKey: "follow-up:kirmanak/demo#9:base1",
      delivery: "d202",
      jobKind: "follow-up",
    });
    const lookup = await store.lookupByHead("gitea", "kirmanak", "demo", "next2");
    expect(lookup.status).toBe("known");
    expect(lookup.contributors).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);
    // An untracked newer head is never described by the earlier row.
    expect((await store.lookupByHead("gitea", "kirmanak", "demo", "next3")).status).toBe("unknown");
  });

  test("duplicate confirms are idempotent and mixed runners merge", async () => {
    await reset();
    const input = {
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 11,
      branch: "jumi/issue-12-a",
      headSha: "dup1",
      contributors: [{ type: "claude", model: "claude-opus-5", effort: "high" }],
      publisher: { type: "claude", model: "claude-opus-5", effort: "high" },
      jobId: 301,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d301",
      jobKind: "implement",
    };
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 0,
      branch: "jumi/issue-12-a",
      jobId: 301,
      jobKey: input.jobKey,
      jobKind: "implement",
      delivery: "d301",
    });
    await store.confirmPublication(input);
    await store.confirmPublication(input);
    // A reclaimed job confirming the same head with an extra surviving runner merges.
    await store.confirmPublication({
      ...input,
      jobId: 302,
      jobKey: "follow-up:kirmanak/demo#11:dup1",
      jobKind: "follow-up",
      delivery: "d302",
      contributors: [
        { type: "claude", model: "claude-opus-5", effort: "high" },
        { type: "opencode", model: "xai/grok-4.6", variant: "high" },
      ],
      publisher: { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    });
    expect(await countProvenance()).toBe(1);
    const lookup = await store.lookupByHead("gitea", "kirmanak", "demo", "dup1");
    expect(lookup.contributors).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);
  });

  test("failed push never looks confirmed and survives restarts", async () => {
    await reset();
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 13,
      branch: "jumi/issue-12-a",
      jobId: 401,
      jobKey: "follow-up:kirmanak/demo#13:base",
      jobKind: "follow-up",
      delivery: "d401",
    });
    await store.markIntentFailed(401, "push rejected", "badhead");
    const restarted = reopen();
    expect((await restarted.lookupByHead("gitea", "kirmanak", "demo", "badhead")).status).toBe("unknown");
    expect(
      (
        await restarted.lookupForReview({
          forge: "gitea",
          owner: "kirmanak",
          repo: "demo",
          prNumber: 13,
          headSha: "badhead",
          branch: "jumi/issue-12-a",
        })
      ).status
    ).toBe("failed");
    expect(await countProvenance()).toBe(0);
  });
});
