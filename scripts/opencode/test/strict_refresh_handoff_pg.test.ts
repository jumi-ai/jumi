import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Check, Pull } from "../src/ports.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { shouldEnqueueStrictRefreshForPR, shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { PgStrictRefreshSlotStore, STRICT_REFRESH_SLOT_TIMEOUT_MS } from "../src/strict_refresh_queue.ts";
import { expireStrictRefreshSlotsOnTick } from "../src/strict_refresh_terminal.ts";
import type { IssueJob } from "../src/types.ts";
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

function pushPayload(after = "base-2"): any {
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

function checkState(state: Check["state"]): Check {
  return { context: "ci", state, status: state };
}

function reviewGreen(): Check {
  return { context: "jumi/opencode-review", state: "success", status: "success" };
}

function githubApi(opts: { list: Pull[]; fresh: Record<number, Pull>; statuses?: Record<string, Check[]> }) {
  return {
    listOpenPulls: async () => opts.list,
    getPR: async (_o: string, _r: string, index: number) => {
      const fresh = opts.fresh[index];
      if (!fresh) throw new Error(`GitHub pull request #${index} unreadable`);
      return fresh;
    },
    getBranch: async () => ({ protected: true, strict: true, requiredContexts: ["ci"] }),
    listCommitStatuses: async (_o: string, _r: string, sha: string) => opts.statuses?.[sha] ?? [],
    listCheckRuns: async () => [],
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    }),
  } as never;
}

function simpleApi(pulls: Pull[]) {
  return {
    listOpenPulls: async () => pulls,
    getBranch: async () => ({ protected: true, strict: true }) as never,
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    }),
    listCommitStatuses: async () => [{ context: "jumi/opencode-review", state: "success" }],
    listCheckRuns: async () => [],
  } as never;
}

describePg("strict handoff against real postgres (#893)", () => {
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

  test("timeout of the oldest ready holder admits the next and queues its job", async () => {
    const list = [jumiPull(890), jumiPull(891)];
    const fresh: Record<number, Pull> = {
      890: jumiPull(890, { mergeableState: "behind" }),
      891: jumiPull(891, { mergeableState: "behind" }),
    };
    const statuses = {
      "head-890": [checkState("success"), reviewGreen()],
      "head-891": [checkState("success"), reviewGreen()],
    };
    const api = githubApi({ list, fresh, statuses });

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(890);

    const timedOut = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      api,
      undefined,
      slots,
      1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1
    );
    expect(timedOut.jobs).toHaveLength(1);
    expect(timedOut.jobs[0]?.prNumber).toBe(891);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(891);
    expect(await slots.getTerminal("o", "r", "main")).toMatchObject({ prNumber: 890, reason: "timeout" });
  });

  test("newer-PR activity admits the oldest", async () => {
    const api = simpleApi([jumiPull(100), jumiPull(101)]);
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: jumiPull(101),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
      slots,
      nowMs: 1_000,
    });
    expect(job?.prNumber).toBe(100);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("admission without enqueue is healed by the tick from the durable intent", async () => {
    const api = simpleApi([jumiPull(100)]);
    const admitted = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(admitted.jobs).toHaveLength(1);
    expect((await slots.getSlot("o", "r", "main"))?.pendingJob?.prNumber).toBe(100);

    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: api as never,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      nowMs: 2_000,
    });
    expect(summary).toEqual({ expired: 0, enqueued: 1 });
    expect(enqueued[0]?.prNumber).toBe(100);
    expect((await slots.getSlot("o", "r", "main"))?.pendingJob).toBeUndefined();
  });

  test("ensureAdmitNextDue never clobbers a held slot (pg parity with memory)", async () => {
    expect(await slots.ensureAdmitNextDue("o", "r", "main", 1_000)).toBe(true);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(1);
    expect(await slots.consumeAdmitNext("o", "r", "main")).toBe(true);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(0);

    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-1",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    expect(await slots.ensureAdmitNextDue("o", "r", "main", 2_000)).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
    expect(await slots.listAdmitNextDue(2_000)).toHaveLength(0);
  });
});
