import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { PgStrictRefreshSlotStore, STRICT_REFRESH_MAX_LAPS } from "../src/strict_refresh_queue.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function jumiPull(number: number, overrides: Partial<Pull> = {}): Pull {
  const issue = 1000 + number;
  return {
    number,
    title: `Fix ${number}`,
    body: `Fixes #${issue}`,
    state: "open",
    html_url: `https://github.com/o/r/pull/${number}`,
    user: { login: "jumi" },
    head: {
      ref: `jumi/issue-${issue}-fix`,
      sha: `head-${number}`,
      repo: { full_name: "o/r", clone_url: "https://github.com/o/r.git" },
    },
    base: { ref: "main", sha: "base-1" },
    merged: false,
    draft: false,
    autoMergeEnabled: true,
    created_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    ...overrides,
  };
}

function pushPayload(after: string): any {
  return {
    ref: "refs/heads/main",
    before: "base-1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://github.com/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  };
}

const policy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
} as never;

function strictApi(pulls: Pull[]) {
  return {
    listOpenPulls: async () => pulls,
    getBranch: async () => ({ protected: true, strict: true }) as never,
  } as never;
}

describePg("strict re-refresh laps against real postgres (#874)", () => {
  let sql!: SqlClient;
  let slots!: PgStrictRefreshSlotStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    slots = new PgStrictRefreshSlotStore(sql);
    await slots.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE strict_refresh_slots`);
  });

  test("push for new base re-refreshes the holder; duplicate is a no-op; head-only is not a refresh", async () => {
    const holder = jumiPull(863);
    const waiting = jumiPull(864);
    const pulls = [holder, waiting];
    const api = strictApi(pulls);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-1"), policy, api, log, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(863);

    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 2_000);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]?.prNumber).toBe(863);
    expect(second.jobs[0]?.strictBaseSha).toBe("base-2");
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(863);
    expect((await slots.getSlot("o", "r", "main"))?.laps).toBe(1);

    const dup = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 3_000);
    expect(dup.jobs).toHaveLength(0);

    const movedHead = jumiPull(863, {
      head: { ref: holder.head.ref, sha: "head-863-new", repo: holder.head.repo },
    });
    const headMove = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([movedHead, waiting]),
      log,
      slots,
      4_000
    );
    expect(headMove.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.laps).toBe(1);
  });

  test("laps exceed the budget: release with laps and admit the next; laps survive reload", async () => {
    const holder = jumiPull(863);
    const next = jumiPull(864);
    const api = strictApi([holder, next]);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-1"), policy, api, log, slots, 1_000);
    for (let i = 2; i <= 1 + STRICT_REFRESH_MAX_LAPS; i++) {
      const res = await shouldEnqueueStrictRefreshOnPush(pushPayload(`base-${i}`), policy, api, log, slots, i * 1_000);
      expect(res.jobs[0]?.prNumber).toBe(863);
    }
    // Reload the store against the same database: the lap count survives.
    const reloaded = new PgStrictRefreshSlotStore(sql);
    expect((await reloaded.getSlot("o", "r", "main"))?.laps).toBe(STRICT_REFRESH_MAX_LAPS);
    expect((await reloaded.getSlot("o", "r", "main"))?.prNumber).toBe(863);

    const exceeded = await shouldEnqueueStrictRefreshOnPush(
      pushPayload(`base-${2 + STRICT_REFRESH_MAX_LAPS}`),
      policy,
      api,
      log,
      reloaded,
      99_000
    );
    expect(exceeded.jobs).toHaveLength(1);
    expect(exceeded.jobs[0]?.prNumber).toBe(864);
    expect((await reloaded.getTerminal("o", "r", "main"))?.reason).toBe("laps");
  });

  test("migration adds the laps column to a pre-existing table", async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS strict_refresh_slots`);
    await sql.unsafe(
      `CREATE TABLE strict_refresh_slots (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        pr_number INTEGER,
        head_sha TEXT,
        base_sha TEXT,
        admitted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        last_terminal_pr INTEGER,
        last_terminal_head TEXT,
        last_terminal_base TEXT,
        last_terminal_reason TEXT,
        last_terminal_at TIMESTAMPTZ,
        PRIMARY KEY (owner, repo, base_branch)
      )`
    );
    const fresh = new PgStrictRefreshSlotStore(sql);
    await fresh.migrate();
    const admitted = await fresh.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 863,
      headSha: "head-863",
      baseSha: "base-1",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
      laps: 0,
    });
    expect(admitted).toBe(true);
    expect((await fresh.getSlot("o", "r", "main"))?.laps).toBe(0);
    await fresh.touch("o", "r", "main", 863, "head-863", "base-2", 2_000);
    expect((await fresh.getSlot("o", "r", "main"))?.laps).toBe(1);
  });
});
