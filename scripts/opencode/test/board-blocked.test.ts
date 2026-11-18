import { describe, expect, test } from "bun:test";
import { BLOCKED_IMPLEMENT_KICK_EFFECT, buildBoardGroups, createBoardFetchHandler } from "../src/board.ts";
import { DEPENDENCY_CYCLE_REASON } from "../src/dependencies.ts";
import {
  createBunSqlClient,
  MemoryReviewJobStore,
  PgReviewJobStore,
  type ReviewJobRecord,
} from "../src/review_jobs.ts";
import { makeIssueJob, makeLinkedIssue } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

function kickRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS, ...headers }),
    body: JSON.stringify(body),
  });
}

async function seedBlocked(
  store: MemoryReviewJobStore,
  reason = "blocked on #12, #15",
  issueNumber = 12
): Promise<number> {
  await store.enqueueIssue(makeIssueJob({ delivery: `d-blocked-${issueNumber}`, issueNumber }));
  const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
  if (!leased) throw new Error("expected an implement lease");
  await store.saveResult(leased.id, "worker", { kind: "skip", reason });
  await store.markPublished(leased.id, "worker", { state: "skipped", reason });
  return leased.id;
}

async function seedNoChanges(store: MemoryReviewJobStore, issueNumber = 12): Promise<number> {
  await store.enqueueIssue(makeIssueJob({ delivery: `d-nc-${issueNumber}`, issueNumber }));
  const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
  if (!leased) throw new Error("expected an implement lease");
  await store.saveResult(leased.id, "worker", { kind: "skip", reason: "no-changes" });
  await store.markPublished(leased.id, "worker", { state: "skipped", reason: "no-changes" });
  await store.sits.remember("kirmanak", "demo", issueNumber, "no-changes");
  return leased.id;
}

function blockedForge(opts: { depsFor12: Array<{ number: number; state: "open" | "closed" }>; labelCalls?: string[] }) {
  const labelCalls = opts.labelCalls ?? [];
  return {
    getPR: async () => ({ state: "closed", merged: false, head: { sha: "deadbeef" } }),
    closePullRequest: async () => ({}),
    reopenPullRequest: async () => ({}),
    addIssueLabel: async (_o: string, _r: string, _n: number, label: string) => {
      labelCalls.push(label);
      return {};
    },
    listIssueDependencies: async (_o: string, _r: string, index: number) => {
      if (index !== 12) return [];
      return opts.depsFor12.map((d) => makeLinkedIssue({ number: d.number, state: d.state }));
    },
    listOpenPulls: async () => [],
    __labelCalls: labelCalls,
  };
}

describe("board blocked implement listing (#668)", () => {
  test("blocked skipped implement appears in needs_kick with implement kick", async () => {
    const store = new MemoryReviewJobStore();
    await seedBlocked(store, "blocked on #196");
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(0);
    const row = groups.needs_kick.find((item) => item.number === 12 && item.kind === "implement");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      owner: "kirmanak",
      repo: "demo",
      number: 12,
      kind: "implement",
      message: "blocked on #196",
      kick: { kick: "implement", effect: BLOCKED_IMPLEMENT_KICK_EFFECT },
    });
    expect(row?.reason).not.toBe(row?.message);
  });

  test("with a queued implement row it does not appear", async () => {
    const store = new MemoryReviewJobStore();
    await seedBlocked(store, "blocked on #12");
    // Queue a new implement row for the same issue: the board row goes away.
    await store.enqueueIssue(makeIssueJob({ delivery: "d-queued", issueNumber: 12 }));
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick.filter((item) => item.kind === "implement")).toHaveLength(0);
    expect(groups.in_progress.length).toBeGreaterThan(0);
  });

  test("succeeded latest and non-blocked skipped stay off the board", async () => {
    const done = new MemoryReviewJobStore();
    await done.enqueueIssue(makeIssueJob({ delivery: "d-done" }));
    const leasedDone = await done.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leasedDone) throw new Error("expected lease");
    await done.saveResult(leasedDone.id, "worker", { kind: "markdown", markdown: "done" });
    await done.markPublished(leasedDone.id, "worker", { state: "succeeded" });
    expect((await buildBoardGroups(done)).needs_kick.filter((i) => i.kind === "implement")).toHaveLength(0);

    const other = new MemoryReviewJobStore();
    await other.enqueueIssue(makeIssueJob({ delivery: "d-other" }));
    const leasedOther = await other.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leasedOther) throw new Error("expected lease");
    await other.saveResult(leasedOther.id, "worker", { kind: "skip", reason: "no-changes" });
    await other.markPublished(leasedOther.id, "worker", { state: "skipped", reason: "no-changes" });
    // A no-changes terminal is retried via the kick route, never listed on the board.
    expect((await buildBoardGroups(other)).needs_kick.filter((i) => i.kind === "implement")).toHaveLength(0);
  });

  test("closed issue does not list", async () => {
    const store = new MemoryReviewJobStore();
    await seedBlocked(store, "blocked on #12");
    await store.sits.markPullClosed?.("kirmanak", "demo", 12);
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick.filter((i) => i.kind === "implement")).toHaveLength(0);
  });
});

describe("board blocked implement kick (#668)", () => {
  test("ready (blocker closed): 200, one queued row, latch cleared, kick log ok", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedBlocked(store, "blocked on #196");
    await store.sits.remember("kirmanak", "demo", 12, "no-changes");
    const labelCalls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [{ number: 196, state: "closed" }], labelCalls }),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 12, kick: "implement", idempotencyKey: "blk-ready-1" };
    const ok = await handler(kickRequest(item));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.terminalJobId).toBe(terminalId);
    expect(body.deduped).toBe(false);
    expect(typeof body.jobId).toBe("number");
    expect(body.key).toBe("implement:kirmanak/demo#12");
    expect(labelCalls).toEqual(["jumi"]);
    expect(await store.sits.get("kirmanak", "demo", 12)).toBeUndefined();
    const queued = await store.get(body.jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.jobKey).toBe("implement:kirmanak/demo#12");
    // Exactly one queued implement row (the terminal stays skipped).
    const inflight = await store.listInflight(200);
    expect(inflight.filter((r) => r.jobKey === "implement:kirmanak/demo#12" && r.state === "queued")).toHaveLength(1);
    expect((await store.getKickByIdempotencyKey("blk-ready-1"))?.result).toBe("ok");

    // Same key replays the ok without a second job or label call.
    const replay = await handler(kickRequest(item));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ jobId: body.jobId, terminalJobId: terminalId, deduped: true });
    expect(labelCalls).toEqual(["jumi"]);
  });

  test("ready with no dependencies: 200", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedBlocked(store, "blocked on #196");
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [] }),
    });
    const ok = await handler(
      kickRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement", idempotencyKey: "blk-nodeps" })
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>).terminalJobId).toBe(terminalId);
  });

  test("blocked (blocker open): 409 still-blocked, why names blocker, no row, kick log still-blocked", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedBlocked(store, "blocked on #196");
    const labelCalls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [{ number: 196, state: "open" }], labelCalls }),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 12, kick: "implement", idempotencyKey: "blk-still-1" };
    const res = await handler(kickRequest(item));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("still-blocked");
    expect(String(body.error)).toContain("#196");
    expect(body.terminalJobId).toBe(terminalId);
    expect(body.newJobId).toBeNull();
    expect(labelCalls).toHaveLength(0);
    // No new row queued.
    expect((await store.listInflight(200)).filter((r) => r.state === "queued")).toHaveLength(0);
    expect((await store.getKickByIdempotencyKey("blk-still-1"))?.result).toBe("still-blocked");

    // Same key replays the still-blocked.
    const replay = await handler(kickRequest(item));
    expect(replay.status).toBe(409);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody).toMatchObject({ code: "still-blocked", terminalJobId: terminalId, deduped: true });
  });

  test("stuck live cycle: 422 not-kickable with the cycle reason", async () => {
    const store = new MemoryReviewJobStore();
    await seedBlocked(store, "blocked on #196");
    const forge = {
      getPR: async () => ({ state: "closed", merged: false, head: { sha: "deadbeef" } }),
      closePullRequest: async () => ({}),
      reopenPullRequest: async () => ({}),
      addIssueLabel: async () => ({}),
      listIssueDependencies: async (_o: string, _r: string, index: number) => {
        if (index === 12) return [makeLinkedIssue({ number: 196 })];
        if (index === 196) return [makeLinkedIssue({ number: 12 })];
        return [];
      },
      listOpenPulls: async () => [],
    };
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: forge,
    });
    const res = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("not-kickable");
    expect(String(body.error)).toContain(DEPENDENCY_CYCLE_REASON);
  });

  test("dependency-cycle terminal row is refused as today", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ delivery: "d-cycle" }));
    const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leased) throw new Error("expected lease");
    await store.saveResult(leased.id, "worker", { kind: "skip", reason: DEPENDENCY_CYCLE_REASON });
    await store.markPublished(leased.id, "worker", { state: "skipped", reason: DEPENDENCY_CYCLE_REASON });
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [] }),
    });
    const res = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("not-kickable");
  });

  test("no-changes retry still queues and succeeded still refuses", async () => {
    const nc = new MemoryReviewJobStore();
    await seedNoChanges(nc);
    const ncHandler = createBoardFetchHandler({
      store: nc,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [] }),
    });
    const ok = await ncHandler(
      kickRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement", idempotencyKey: "nc-still-ok" })
    );
    expect(ok.status).toBe(200);

    const done = new MemoryReviewJobStore();
    await done.enqueueIssue(makeIssueJob({ delivery: "d-done2" }));
    const leased = await done.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leased) throw new Error("expected lease");
    await done.saveResult(leased.id, "worker", { kind: "markdown", markdown: "done" });
    await done.markPublished(leased.id, "worker", { state: "succeeded" });
    const doneHandler = createBoardFetchHandler({
      store: done,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge({ depsFor12: [] }),
    });
    const refused = await doneHandler(kickRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement" }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Record<string, unknown>).code).toBe("not-kickable");
  });

  test("store implementKick accepts blocked-on directly (memory)", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedBlocked(store, "blocked on #196");
    const outcome = await store.implementKick({
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      kick: "implement",
      actor: "operator",
      idempotencyKey: "mem-direct",
      delivery: "d-direct",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.terminalId).toBe(terminalId);
    expect(outcome.job.jobKey).toBe("implement:kirmanak/demo#12");
  });

  test("memory listTerminalImplements returns implement terminals newest first", async () => {
    const store = new MemoryReviewJobStore();
    await seedBlocked(store, "blocked on #1", 12);
    await seedNoChanges(store, 13);
    const rows = await store.listTerminalImplements?.(200);
    expect(rows?.map((r) => r.issueNumber).sort()).toEqual([12, 13]);
  });
});

const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const describePg = databaseUrl ? describe : describe.skip;

describePg("board blocked implement on postgres (#668)", () => {
  test("pg implementKick accepts blocked-on and lists terminal implements", async () => {
    const sql = createBunSqlClient(databaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, review_kicks RESTART IDENTITY`);
      const job = makeIssueJob({ delivery: "d-pg-blocked", issueNumber: 12 });
      await store.enqueueIssue(job);
      const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
      if (!leased) throw new Error("expected lease");
      await store.saveResult(leased.id, "worker", { kind: "skip", reason: "blocked on #196" });
      await store.markPublished(leased.id, "worker", { state: "skipped", reason: "blocked on #196" } as never);
      const listed = await store.listTerminalImplements?.(200);
      expect(listed?.some((r: ReviewJobRecord) => r.issueNumber === 12 && r.resultReason === "blocked on #196")).toBe(
        true
      );
      const outcome = await store.implementKick({
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        kick: "implement",
        actor: "operator",
        idempotencyKey: "pg-blocked-1",
        delivery: "d-pg-kick",
      });
      expect(outcome.status).toBe("ok");
      // still-blocked replay path on the pg store: log then replay.
      await store.recordImplementKick({
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        kick: "implement",
        actor: "operator",
        idempotencyKey: "pg-still-1",
        result: "still-blocked",
        terminalJobId: leased.id,
        newJobId: null,
      });
      const prior = await store.getKickByIdempotencyKey("pg-still-1");
      expect(prior?.result).toBe("still-blocked");
    } finally {
      await sql.close?.();
    }
  });
});
