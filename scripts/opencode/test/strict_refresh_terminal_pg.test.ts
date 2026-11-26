import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { PgStrictRefreshSlotStore, STRICT_REFRESH_SLOT_TIMEOUT_MS } from "../src/strict_refresh_queue.ts";
import {
  expireStrictRefreshSlotsOnTick,
  releaseStrictSlotForTerminalJob,
  STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON,
  settleStrictSlotForWorkerOutcome,
} from "../src/strict_refresh_terminal.ts";
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

function strictApi(pulls: Pull[], listOpenPulls?: () => Promise<Pull[]>) {
  return {
    listOpenPulls: listOpenPulls ?? (async () => pulls),
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

describePg("strict terminal release and tick expiry against real postgres (#875)", () => {
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

  test("terminal skip releases, records job-ended, and admits the next ready PR", async () => {
    const holder = jumiPull(100);
    const next = jumiPull(101);
    const api = strictApi([holder, next]);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(100);

    const released = await settleStrictSlotForWorkerOutcome({
      slots,
      job: { ...first.jobs[0], delivery: "d1", receivedAt: new Date().toISOString() } as IssueJob,
      status: "skipped",
      reason: "strict refresh: closing issue not picked up or closed",
      log,
      nowMs: 2_000,
    });
    expect(released).toBe(true);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect(await slots.getTerminal("o", "r", "main")).toMatchObject({
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      reason: "job-ended",
    });
    expect(logs.some((m) => m.includes("released (holder #100 job ended:"))).toBe(true);

    const admitted = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 3_000);
    expect(admitted.jobs).toHaveLength(1);
    expect(admitted.jobs[0]?.prNumber).toBe(101);
  });

  test("failed and reclaimed outcomes release; busy and success keep the slot", async () => {
    const api = strictApi([jumiPull(100), jumiPull(101)]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);

    // A stale result for an older admission does not release the current holder.
    const stale = await releaseStrictSlotForTerminalJob({
      slots,
      owner: "o",
      repo: "r",
      prNumber: 100,
      headSha: "head-100-old",
      baseSha: "base-2",
      reason: "strict refresh: competing head update",
      nowMs: 2_000,
    });
    expect(stale).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);

    // Retryable busy keeps the slot; no terminal is recorded.
    const busy = await settleStrictSlotForWorkerOutcome({
      slots,
      job: {
        strictRefresh: true,
        mergeOnly: true,
        prNumber: 100,
        headSha: "head-100",
        strictBaseSha: "base-2",
        owner: "o",
        repo: "r",
      },
      status: "skipped",
      reason: "strict refresh: branch writer busy; retry after writer finishes (claimed)",
      nowMs: 3_000,
    });
    expect(busy).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);

    // Failed without retries left releases.
    const failed = await settleStrictSlotForWorkerOutcome({
      slots,
      job: {
        strictRefresh: true,
        mergeOnly: true,
        prNumber: 100,
        headSha: "head-100",
        strictBaseSha: "base-2",
        owner: "o",
        repo: "r",
      },
      status: "failed",
      reason: "Jumi failed: max attempts exceeded",
      nowMs: 4_000,
    });
    expect(failed).toBe(true);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect((await slots.getTerminal("o", "r", "main"))?.reason).toBe(STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON);
  });

  test("engine tick expires the slot and admits the next ready PR with one listOpenPulls", async () => {
    const holder = jumiPull(100);
    const next = jumiPull(101);
    let listOpenPulls = 0;
    const api = strictApi([holder, next], async () => {
      listOpenPulls += 1;
      return [holder, next];
    });
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    listOpenPulls = 0;

    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      log,
      nowMs: 1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1,
    });
    expect(summary).toEqual({ expired: 1, enqueued: 1 });
    expect(listOpenPulls).toBe(1);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
    expect((await slots.getTerminal("o", "r", "main"))?.reason).toBe("timeout");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.prNumber).toBe(101);
  });

  test("a tick with no expired slot makes no forge calls", async () => {
    const throwing = {
      listOpenPulls: async (): Promise<Pull[]> => {
        throw new Error("listOpenPulls must not be called");
      },
      getBranch: async () => {
        throw new Error("getBranch must not be called");
      },
      getRepo: async () => {
        throw new Error("getRepo must not be called");
      },
    } as never;
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    let enqueued = 0;
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: throwing,
      policy,
      enqueueIssue: async () => {
        enqueued += 1;
        return { queued: true, key: "k" };
      },
      nowMs: 2_000,
    });
    expect(summary).toEqual({ expired: 0, enqueued: 0 });
    expect(enqueued).toBe(0);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });
});
