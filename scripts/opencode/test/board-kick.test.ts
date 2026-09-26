import { describe, expect, test } from "bun:test";
import { createBoardFetchHandler } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeJob } from "./fixtures.ts";

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
