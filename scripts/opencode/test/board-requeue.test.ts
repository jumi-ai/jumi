import { describe, expect, test } from "bun:test";
import { buildBoardGroups, createBoardFetchHandler, REQUEUE_KICK_EFFECT, renderBoardPage } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeJob } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const INCOMPLETE_REASON = "Incomplete review: no output";

function boardRequest(path = "/api/board", headers: Record<string, string> = {}): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(headers) });
}

function kickRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS, ...headers }),
    body: JSON.stringify(body),
  });
}

async function seedSkippedIncomplete(
  store: MemoryReviewJobStore,
  opts: { prNumber?: number; headSha?: string; reason?: string } = {}
): Promise<number> {
  const prNumber = opts.prNumber ?? 7;
  const headSha = opts.headSha ?? HEAD_SHA;
  const reason = opts.reason ?? INCOMPLETE_REASON;
  await store.enqueue(makeJob({ delivery: `d-${prNumber}-${headSha.slice(0, 6)}`, prNumber, headSha }));
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  await store.saveResult(leased.id, "worker", { kind: "skip", reason });
  await store.markPublished(leased.id, "worker", { state: "skipped", reason });
  return leased.id;
}

async function seedFailed(
  store: MemoryReviewJobStore,
  prNumber = 7,
  headSha = HEAD_SHA,
  reason = "boom"
): Promise<number> {
  await store.enqueue(makeJob({ delivery: `d-fail-${prNumber}`, prNumber, headSha }));
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  await store.saveResult(leased.id, "worker", { kind: "error", error: reason });
  await store.markPublished(leased.id, "worker", { state: "failed", reason });
  return leased.id;
}

describe("board requeue review kick (#260)", () => {
  test("skipped Incomplete review offers Requeue review; POST requeues the same job key", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedSkippedIncomplete(store);
    // Close/reopen dedupes against the terminal row and records a terminal-result sit.
    await store.sits.remember("kirmanak", "demo", 7, "terminal-result");

    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(0);
    expect(groups.needs_kick).toHaveLength(1);
    const row = groups.needs_kick[0];
    expect(row).toMatchObject({
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kind: "review",
      commit: HEAD_SHA,
      headSha: HEAD_SHA,
      kick: { effect: REQUEUE_KICK_EFFECT, kick: INCOMPLETE_REASON },
    });
    expect(row.reason).toBe("review skipped");
    expect(typeof row.message).toBe("string");
    expect(row.message).not.toBe(row.reason);
    // The terminal-result sit is replaced, never shown as "Sitting on purpose".
    expect(groups.sitting).toHaveLength(0);

    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const board = (await (await handler(boardRequest("/api/board", EDGE_HEADERS))).json()) as Record<string, unknown>;
    const needsKick = board.needs_kick as Record<string, unknown>[];
    expect(needsKick).toHaveLength(1);
    expect(needsKick[0]).toMatchObject({
      number: 7,
      commit: HEAD_SHA,
      headSha: HEAD_SHA,
      kick: { effect: REQUEUE_KICK_EFFECT, kick: INCOMPLETE_REASON },
    });

    const terminal = await store.get(terminalId);
    const jobKey = terminal?.jobKey;
    expect(typeof jobKey).toBe("string");

    const ok = await handler(
      kickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: INCOMPLETE_REASON,
        idempotencyKey: "requeue-1",
      })
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.terminalJobId).toBe(terminalId);
    expect(okBody.deduped).toBe(false);
    expect(typeof okBody.jobId).toBe("number");
    expect(okBody.jobId).not.toBe(terminalId);
    expect(okBody.key).toBe(jobKey);

    const queued = await store.get(okBody.jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.headSha).toBe(HEAD_SHA);
    expect(queued?.jobKey).toBe(jobKey);
    // Terminal row is kept alongside the new queued row.
    expect((await store.get(terminalId))?.state).toBe("skipped");

    // After the kick the pull is in progress, not offered again.
    const after = await buildBoardGroups(store);
    expect(after.in_progress).toHaveLength(1);
    expect(after.needs_kick).toHaveLength(0);
    expect(after.sitting).toHaveLength(0);
  });

  test("failed review is also requeueable with the full head SHA", async () => {
    const store = new MemoryReviewJobStore();
    const terminalId = await seedFailed(store);
    await store.sits.remember("kirmanak", "demo", 7, "terminal-result");

    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick).toHaveLength(1);
    expect(groups.needs_kick[0]).toMatchObject({
      commit: HEAD_SHA,
      headSha: HEAD_SHA,
      kick: { effect: REQUEUE_KICK_EFFECT, kick: "boom" },
    });
    expect(groups.sitting).toHaveLength(0);

    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const ok = await handler(
      kickRequest({ owner: "kirmanak", repo: "demo", number: 7, commit: HEAD_SHA, kick: "boom" })
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>).terminalJobId).toBe(terminalId);
  });

  test("succeeded, cancelled, and disabled reasons stay buttonless", async () => {
    const disabledReasons = [
      "provider auth death",
      "status description rejected: too long",
      "CI still pending",
      "repo-mutex",
      "draft or WIP pull request",
      "blocked on #196",
      "stuck: dependency cycle",
      "stalled: no heartbeat for 10m",
      "killed by SIGKILL",
      "Jumi review failed: max attempts exceeded",
      "PR head changed from aaa to bbb",
      "PR is closed",
      "PR is merged",
      "PR is already merged",
      "Incomplete review: HEAD moved",
    ];
    for (const reason of disabledReasons) {
      const store = new MemoryReviewJobStore();
      await seedSkippedIncomplete(store, { reason });
      await store.sits.remember("kirmanak", "demo", 7, "terminal-result");
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick).toHaveLength(0);
      expect(groups.sitting.map((item) => item.reason)).toEqual(["terminal-result"]);
      for (const item of groups.sitting) expect(item.kick).toBeUndefined();

      const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
      const refused = await handler(
        kickRequest({ owner: "kirmanak", repo: "demo", number: 7, commit: HEAD_SHA, kick: reason })
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as Record<string, unknown>).code).toBe("not-kickable");
    }

    // Succeeded reviews never offer a kick.
    {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob({ delivery: "d-done", prNumber: 7, headSha: HEAD_SHA }));
      const leased = await store.lease("worker", 60_000);
      if (!leased) throw new Error("expected a leased job");
      await store.saveResult(leased.id, "worker", { kind: "markdown", markdown: "done" });
      await store.markPublished(leased.id, "worker", { state: "succeeded" });
      await store.sits.remember("kirmanak", "demo", 7, "terminal-result");
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick).toHaveLength(0);
      expect(groups.sitting.map((item) => item.reason)).toEqual(["terminal-result"]);
    }

    // Cancelled latest terminal never offers a kick, even with a stored reason.
    {
      const store = new MemoryReviewJobStore();
      const terminalId = await seedFailed(store, 7, HEAD_SHA, "boom");
      const terminal = await store.get(terminalId);
      if (!terminal) throw new Error("expected a terminal job");
      store.rows.push({
        ...terminal,
        id: terminalId + 1000,
        state: "cancelled",
        resultReason: "boom",
        error: "boom",
      });
      await store.sits.remember("kirmanak", "demo", 7, "terminal-result");
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick).toHaveLength(0);
      expect(groups.sitting.map((item) => item.reason)).toEqual(["terminal-result"]);
    }
  });

  test("stale kick id is 409 with a clear message", async () => {
    const store = new MemoryReviewJobStore();
    await seedSkippedIncomplete(store);
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const stale = await handler(
      kickRequest({ owner: "kirmanak", repo: "demo", number: 7, commit: HEAD_SHA, kick: "wrong-reason" })
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as Record<string, unknown>;
    expect(body.code).toBe("stale-kick");
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  test("closed pull with a failed terminal shows no requeue row", async () => {
    const store = new MemoryReviewJobStore();
    await seedFailed(store);
    await store.sits.markPullClosed?.("kirmanak", "demo", 7);
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick).toHaveLength(0);
    expect(groups.in_progress).toHaveLength(0);

    // Reopen clears the marker so the requeue row comes back. Use a skipped
    // Incomplete terminal here: it dedupes on reopen (same SHA) instead of
    // inserting a new queued row, so the row returns as needs_kick.
    const reopened = new MemoryReviewJobStore();
    await seedSkippedIncomplete(reopened);
    await reopened.sits.markPullClosed?.("kirmanak", "demo", 7);
    expect((await buildBoardGroups(reopened)).needs_kick).toHaveLength(0);
    await reopened.enqueue(makeJob({ delivery: "d-reopen-7", prNumber: 7, headSha: HEAD_SHA, action: "reopened" }));
    const afterReopen = await buildBoardGroups(reopened);
    expect(afterReopen.needs_kick).toHaveLength(1);
    expect(afterReopen.needs_kick[0]).toMatchObject({
      kick: { effect: REQUEUE_KICK_EFFECT, kick: INCOMPLETE_REASON },
    });
  });

  test("page offers Requeue review with the full-SHA payload and clear kick errors", async () => {
    const store = new MemoryReviewJobStore();
    await seedSkippedIncomplete(store);
    await store.sits.remember("kirmanak", "demo", 7, "terminal-result");
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const page = await handler(new Request("https://board.test/board", { headers: new Headers(EDGE_HEADERS) }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Requeue review");
    expect(html).toContain("payload.commit");
    // The confirm states the server-provided effect and surfaces 409/422 detail.
    expect(html).toContain("This will:");
    expect(html).toContain("res.status === 422");
    expect(renderBoardPage("catalog-test")).toContain("Requeue review");
    // The API payload carries the requeue effect for the confirm.
    const board = (await (await handler(boardRequest("/api/board", EDGE_HEADERS))).json()) as Record<string, unknown>;
    const needsKick = board.needs_kick as Record<string, unknown>[];
    expect(needsKick[0]).toMatchObject({ kick: { effect: REQUEUE_KICK_EFFECT } });
  });
});
