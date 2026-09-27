import { describe, expect, test } from "bun:test";
import { createBoardFetchHandler } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { QueueUnavailableError } from "../src/sql_client.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

function kickRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  method = "POST",
  path = "/api/board/kick"
): Request {
  return new Request(`https://board.test${path}`, {
    method,
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS, ...headers }),
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

/** Seed one terminal failed review with a kickable reason; returns the terminal id. */
async function seedFailed(
  store: MemoryReviewJobStore,
  opts: { prNumber?: number; headSha?: string; reason?: string } = {}
): Promise<number> {
  const prNumber = opts.prNumber ?? 7;
  const headSha = opts.headSha ?? "abc123";
  const reason = opts.reason ?? "boom";
  await store.enqueue(makeJob({ delivery: "d-1", prNumber, headSha }));
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  await store.saveResult(leased.id, "worker", { kind: "error", error: reason });
  await store.markPublished(leased.id, "worker", { state: "failed", reason });
  return leased.id;
}

describe("board kick contract (#162)", () => {
  test("ok requeues the same commit, replay dedupes, in-flight conflicts, stale kick rejected", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedFailed(store);
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const item = { owner: "kirmanak", repo: "demo", number: 7, commit: "abc123", kick: "boom" };

    const ok = await handler(kickRequest({ ...item, idempotencyKey: "key-1" }));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.terminalJobId).toBe(terminalId);
    expect(typeof okBody.jobId).toBe("number");
    expect(okBody.jobId).not.toBe(terminalId);
    expect(okBody.deduped).toBe(false);
    const jobId = okBody.jobId;

    // Terminal row is kept: the failed row still exists alongside the new queued row.
    const terminal = await store.get(terminalId);
    expect(terminal?.state).toBe("failed");
    const queued = await store.get(jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.headSha).toBe("abc123");

    // Double submit with the same key returns the first result with no new job.
    const replay = await handler(kickRequest({ ...item, idempotencyKey: "key-1" }));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody).toMatchObject({ jobId, terminalJobId: terminalId, deduped: true });

    // Same key reused for a different item is a client error, never the first job.
    const mismatch = await handler(
      kickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 8,
        commit: "def456",
        kick: "boom",
        idempotencyKey: "key-1",
      })
    );
    expect(mismatch.status).toBe(400);
    const mismatchBody = (await mismatch.json()) as Record<string, unknown>;
    expect(mismatchBody.code).toBe("bad-request");
    // Mismatch is not a replay: no prior job ids leak, no deduped flag.
    expect(mismatchBody.jobId).toBeUndefined();
    expect(mismatchBody.newJobId).toBeNull();
    expect(mismatchBody.terminalJobId).toBeNull();
    expect(mismatchBody.deduped).toBeUndefined();
    expect(String(mismatchBody.error)).toContain("kirmanak/demo#7 @ abc123");

    // In-flight job for that key is a conflict, not a second queued row.
    const conflict = await handler(kickRequest({ ...item, idempotencyKey: "key-2" }));
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as Record<string, unknown>;
    expect(conflictBody.code).toBe("conflict");

    // Kick id must match the item's current reason.
    const stale = await handler(kickRequest({ ...item, kick: "wrong-reason", idempotencyKey: "key-3" }));
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as Record<string, unknown>;
    expect(staleBody.code).toBe("stale-kick");
  });

  test("edge identity required, GET rejected, body actor ignored, board page leaks no kick log", async () => {
    const store = new MemoryReviewJobStore();
    await seedFailed(store);
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const item = { owner: "kirmanak", repo: "demo", number: 7, commit: "abc123", kick: "boom" };

    const noIdentity = await handler(
      new Request("https://board.test/api/board/kick", {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(item),
      })
    );
    expect(noIdentity.status).toBe(401);

    const get = await handler(
      new Request("https://board.test/api/board/kick", { method: "GET", headers: new Headers(EDGE_HEADERS) })
    );
    expect(get.status).toBe(405);

    // The actor is the edge identity, never a body field.
    const ok = await handler(kickRequest({ ...item, actor: "mallory", idempotencyKey: "actor-key" }));
    expect(ok.status).toBe(200);
    const log = await store.listKickLog();
    const entry = log.find((row) => row.idempotencyKey === "actor-key");
    expect(entry?.actor).toBe("operator");

    const page = await handler(
      new Request("https://board.test/board", { method: "GET", headers: new Headers(EDGE_HEADERS) })
    );
    expect(page.status).toBe(200);
    const raw = await page.text();
    expect(raw).not.toContain("review_kicks");
    expect(raw).not.toContain("terminalJobId");
    expect(raw).not.toContain("deduped");
  });

  test("kick requires JSON content type and same origin", async () => {
    const store = new MemoryReviewJobStore();
    await seedFailed(store);
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const item = { owner: "kirmanak", repo: "demo", number: 7, commit: "abc123", kick: "boom" };

    const plain = await handler(
      new Request("https://board.test/api/board/kick", {
        method: "POST",
        headers: new Headers({ "Content-Type": "text/plain", "X-Forwarded-User": "operator" }),
        body: JSON.stringify(item),
      })
    );
    expect(plain.status).toBe(400);

    const crossOrigin = await handler(kickRequest(item, { Origin: "https://evil.test" }));
    expect(crossOrigin.status).toBe(403);
  });

  test("non-kickable reasons stay status lines with a 422", async () => {
    for (const reason of ["provider auth death", "draft or WIP pull request"]) {
      const store = new MemoryReviewJobStore();
      await seedFailed(store, { reason });
      const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
      const response = await handler(
        kickRequest({ owner: "kirmanak", repo: "demo", number: 7, commit: "abc123", kick: reason })
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.code).toBe("not-kickable");
    }
  });
});

describe("board reopen kick contract (#163)", () => {
  function reopenForge(pr: { state: string; merged: boolean; sha?: string }, calls: string[]) {
    return {
      getPR: async () => ({ state: pr.state, merged: pr.merged, head: { sha: pr.sha ?? "deadbeef" } }),
      closePullRequest: async () => {
        calls.push("close");
        return {};
      },
      reopenPullRequest: async () => {
        calls.push("reopen");
        return {};
      },
    };
  }

  function reopenRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
    return kickRequest(body, headers);
  }

  test("closed reopens with close+reopen calls and no job row; replay dedupes", async () => {
    const store = new MemoryReviewJobStore();
    const calls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge({ state: "closed", merged: false }, calls),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 9, kick: "reopen", idempotencyKey: "reopen-1" };

    const ok = await handler(reopenRequest(item));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, reopened: true, deduped: false });
    expect(calls).toEqual(["close", "reopen"]);
    // No job is inserted: the reopen webhook wake is the enqueue.
    expect(await store.listInflight()).toHaveLength(0);
    const logged = await store.getKickByIdempotencyKey("reopen-1");
    expect(logged?.result).toBe("ok");

    const replay = await handler(reopenRequest(item));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, reopened: true, deduped: true });
    // Replay never touches the forge again.
    expect(calls).toEqual(["close", "reopen"]);
  });

  test("open is a noop with no forge writes; merged is 422", async () => {
    const openCalls: string[] = [];
    const openStore = new MemoryReviewJobStore();
    const openHandler = createBoardFetchHandler({
      store: openStore,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge({ state: "open", merged: false }, openCalls),
    });
    const noop = await openHandler(reopenRequest({ owner: "o", repo: "r", number: 1, kick: "reopen" }));
    expect(noop.status).toBe(200);
    expect(await noop.json()).toMatchObject({ ok: true, reopened: false, noop: true });
    expect(openCalls).toHaveLength(0);

    const mergedCalls: string[] = [];
    const mergedStore = new MemoryReviewJobStore();
    const mergedHandler = createBoardFetchHandler({
      store: mergedStore,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge({ state: "closed", merged: true }, mergedCalls),
    });
    const merged = await mergedHandler(reopenRequest({ owner: "o", repo: "r", number: 2, kick: "reopen" }));
    expect(merged.status).toBe(422);
    expect(((await merged.json()) as Record<string, unknown>).code).toBe("not-kickable");
    expect(mergedCalls).toHaveLength(0);
  });

  test("mismatch is 400, missing edge identity is 401, body actor ignored", async () => {
    const store = new MemoryReviewJobStore();
    const calls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge({ state: "closed", merged: false }, calls),
    });
    const first = await handler(
      reopenRequest({ owner: "kirmanak", repo: "demo", number: 9, kick: "reopen", idempotencyKey: "reopen-x" })
    );
    expect(first.status).toBe(200);

    const mismatch = await handler(
      reopenRequest({ owner: "kirmanak", repo: "demo", number: 10, kick: "reopen", idempotencyKey: "reopen-x" })
    );
    expect(mismatch.status).toBe(400);

    const noIdentity = await handler(
      new Request("https://board.test/api/board/kick", {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ owner: "o", repo: "r", number: 1, kick: "reopen" }),
      })
    );
    expect(noIdentity.status).toBe(401);

    const forged = await handler(
      reopenRequest({ owner: "o", repo: "r", number: 3, kick: "reopen", actor: "mallory", idempotencyKey: "actor-x" })
    );
    expect(forged.status).toBe(200);
    expect((await store.getKickByIdempotencyKey("actor-x"))?.actor).toBe("operator");
  });

  test("ledger outage on the ok path is 503, not 500", async () => {
    const store = new MemoryReviewJobStore();
    const failing = Object.create(store) as MemoryReviewJobStore;
    failing.recordReopenKick = async () => {
      throw new QueueUnavailableError(new Error("ledger down"));
    };
    const calls: string[] = [];
    const handler = createBoardFetchHandler({
      store: failing,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge({ state: "closed", merged: false }, calls),
    });
    const response = await handler(reopenRequest({ owner: "o", repo: "r", number: 4, kick: "reopen" }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe("queue unavailable");
  });

  test("memory store enforces the shared idempotency key space", async () => {
    const store = new MemoryReviewJobStore();
    await store.recordReopenKick({
      owner: "o",
      repo: "r",
      number: 1,
      commit: "",
      kick: "reopen",
      actor: "operator",
      idempotencyKey: "dup",
      result: "ok",
    });
    await expect(
      store.recordReopenKick({
        owner: "o",
        repo: "r",
        number: 1,
        commit: "",
        kick: "reopen",
        actor: "operator",
        idempotencyKey: "dup",
        result: "ok",
      })
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("lost race on the ok path: same-key different-item is 400, re-read failure is 503", async () => {
    async function racedStore(key: string, seedNumber: number): Promise<{ store: MemoryReviewJobStore }> {
      const inner = new MemoryReviewJobStore();
      await inner.recordReopenKick({
        owner: "o",
        repo: "r",
        number: seedNumber,
        commit: "sha9",
        kick: "reopen",
        actor: "operator",
        idempotencyKey: key,
        result: "ok",
      });
      // Simulate the pre-check racing: the first read sees nothing even
      // though the key already won elsewhere.
      let reads = 0;
      const store = Object.create(inner) as MemoryReviewJobStore;
      store.getKickByIdempotencyKey = async (k: string) => {
        reads++;
        if (reads === 1) return undefined;
        return inner.getKickByIdempotencyKey(k);
      };
      return { store };
    }

    // Same-key different-item after a lost race must mirror the pre-check 400,
    // not claim success for an item with no ledger row.
    {
      const { store } = await racedStore("race-400", 9);
      const calls: string[] = [];
      const handler = createBoardFetchHandler({
        store,
        getGrantNotice: () => undefined,
        logger: () => {},
        forgeApi: reopenForge({ state: "closed", merged: false }, calls),
      });
      const response = await handler(
        reopenRequest({ owner: "o", repo: "r", number: 10, kick: "reopen", idempotencyKey: "race-400" })
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as Record<string, unknown>).code).toBe("bad-request");
    }

    // A failed re-read after a lost race must be 503, never a success claim.
    {
      const inner = new MemoryReviewJobStore();
      await inner.recordReopenKick({
        owner: "o",
        repo: "r",
        number: 9,
        commit: "sha9",
        kick: "reopen",
        actor: "operator",
        idempotencyKey: "race-503",
        result: "ok",
      });
      let reads = 0;
      const store = Object.create(inner) as MemoryReviewJobStore;
      store.getKickByIdempotencyKey = async (_k: string) => {
        reads++;
        if (reads === 1) return undefined;
        throw new QueueUnavailableError(new Error("ledger down"));
      };
      const calls: string[] = [];
      const handler = createBoardFetchHandler({
        store,
        getGrantNotice: () => undefined,
        logger: () => {},
        forgeApi: reopenForge({ state: "closed", merged: false }, calls),
      });
      const response = await handler(
        reopenRequest({ owner: "o", repo: "r", number: 10, kick: "reopen", idempotencyKey: "race-503" })
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as Record<string, unknown>).error).toBe("queue unavailable");
    }
  });

  test("lost race on a terminal path replays the recorded prior", async () => {
    const inner = new MemoryReviewJobStore();
    await inner.recordReopenKick({
      owner: "o",
      repo: "r",
      number: 5,
      commit: "sha5",
      kick: "reopen",
      actor: "operator",
      idempotencyKey: "race-terminal",
      result: "ok",
    });
    let reads = 0;
    const store = Object.create(inner) as MemoryReviewJobStore;
    store.getKickByIdempotencyKey = async (k: string) => {
      reads++;
      if (reads === 1) return undefined;
      return inner.getKickByIdempotencyKey(k);
    };
    const calls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: {
        getPR: async () => {
          throw new Error("GET pulls → 404 not found");
        },
        closePullRequest: async () => {
          calls.push("close");
          return {};
        },
        reopenPullRequest: async () => {
          calls.push("reopen");
          return {};
        },
      },
    });
    const response = await handler(
      reopenRequest({ owner: "o", repo: "r", number: 5, kick: "reopen", idempotencyKey: "race-terminal" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reopened: true, deduped: true });
    expect(calls).toHaveLength(0);
  });
});

describe("board implement kick contract (#164)", () => {
  async function seedNoChanges(store: MemoryReviewJobStore, overrides: Record<string, unknown> = {}): Promise<number> {
    await store.enqueueIssue(makeIssueJob({ delivery: "d-seed", ...overrides }));
    const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leased) throw new Error("expected an implement lease");
    await store.saveResult(leased.id, "worker", { kind: "skip", reason: "no-changes" });
    await store.markPublished(leased.id, "worker", { state: "skipped", reason: "no-changes" });
    // The terminal wake leaves a sit latch for the board to clear.
    await store.sits.remember("kirmanak", "demo", 12, "no-changes");
    return leased.id;
  }

  function implementForge(labelCalls: string[]) {
    return {
      getPR: async () => ({ state: "closed", merged: false, head: { sha: "deadbeef" } }),
      closePullRequest: async () => ({}),
      reopenPullRequest: async () => ({}),
      addIssueLabel: async (_owner: string, _repo: string, _index: number, label: string) => {
        labelCalls.push(label);
        return {};
      },
    };
  }

  function implementRequest(body: Record<string, unknown>): Request {
    return kickRequest(body);
  }

  test("ok clears the sit and queues, replay returns the same key with no second forge call", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedNoChanges(store);
    const labelCalls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: implementForge(labelCalls),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 12, kick: "implement", idempotencyKey: "impl-1" };

    const ok = await handler(implementRequest(item));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.terminalJobId).toBe(terminalId);
    expect(okBody.deduped).toBe(false);
    expect(typeof okBody.jobId).toBe("number");
    expect(okBody.jobId).not.toBe(terminalId);
    expect(okBody.key).toBe("implement:kirmanak/demo#12");
    expect(labelCalls).toEqual(["jumi"]);
    // Latch cleared, terminal kept, new row queued with the same key.
    expect(await store.sits.get("kirmanak", "demo", 12)).toBeUndefined();
    expect((await store.get(terminalId))?.state).toBe("skipped");
    const queued = await store.get(okBody.jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.jobKey).toBe("implement:kirmanak/demo#12");

    const replay = await handler(implementRequest(item));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody).toMatchObject({
      jobId: okBody.jobId,
      newJobId: okBody.jobId,
      key: "implement:kirmanak/demo#12",
      terminalJobId: terminalId,
      deduped: true,
    });
    expect(labelCalls).toEqual(["jumi"]);

    // In-flight row for that key is a conflict, not a second queued row.
    const conflict = await handler(implementRequest({ ...item, idempotencyKey: "impl-2" }));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as Record<string, unknown>).code).toBe("conflict");

    // Same key reused for a different item is a client error.
    const mismatch = await handler(
      implementRequest({ owner: "kirmanak", repo: "demo", number: 13, kick: "implement", idempotencyKey: "impl-1" })
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as Record<string, unknown>).code).toBe("bad-request");
  });

  test("succeeded and non-no-changes terminals are not kickable", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ delivery: "d-done" }));
    const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leased) throw new Error("expected an implement lease");
    await store.saveResult(leased.id, "worker", { kind: "markdown", markdown: "done" });
    await store.markPublished(leased.id, "worker", { state: "succeeded" });
    const labelCalls: string[] = [];
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: implementForge(labelCalls),
    });
    const refused = await handler(implementRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement" }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Record<string, unknown>).code).toBe("not-kickable");
    expect(labelCalls).toHaveLength(0);

    const other = new MemoryReviewJobStore();
    await other.enqueueIssue(makeIssueJob({ delivery: "d-other" }));
    const leasedOther = await other.lease("worker", 60_000, new Date(), ["implement"]);
    if (!leasedOther) throw new Error("expected an implement lease");
    await other.saveResult(leasedOther.id, "worker", { kind: "skip", reason: "blocked on #196" });
    await other.markPublished(leasedOther.id, "worker", { state: "skipped", reason: "blocked on #196" });
    const otherHandler = createBoardFetchHandler({
      store: other,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: implementForge(labelCalls),
    });
    const blocked = await otherHandler(
      implementRequest({ owner: "kirmanak", repo: "demo", number: 12, kick: "implement" })
    );
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as Record<string, unknown>).code).toBe("not-kickable");
  });
});
