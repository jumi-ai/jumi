import { describe, expect, test } from "bun:test";
import { buildBoardGroups, createBoardFetchHandler, renderBoardPage } from "../src/board.ts";
import { BOARD_BULK_MAX_ITEMS, isBulkEligibleBoardItem, isBulkEligibleReviewRow } from "../src/bulk_requeue.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { makeJob } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };
const NO_OUTPUT = "Incomplete review: no output";
const NO_FINDINGS = "Incomplete review: no findings";
const NO_CHECK_VERDICT = "Incomplete review: no check verdict";
const NO_ARTIFACT = "incomplete review: no artifact";

function headFor(pr: number): string {
  return `${pr}`.padStart(40, `${pr % 10}`);
}

function bulkRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://board.test/api/board/kick/bulk", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS, ...headers }),
    body: JSON.stringify(body),
  });
}

async function seedTerminal(
  store: MemoryReviewJobStore,
  opts: {
    prNumber: number;
    headSha: string;
    state: "failed" | "skipped" | "succeeded";
    reason?: string;
    markdown?: string | null;
    error?: string | null;
  }
): Promise<number> {
  await store.enqueue(
    makeJob({
      delivery: `d-${opts.prNumber}-${opts.headSha.slice(0, 6)}`,
      prNumber: opts.prNumber,
      headSha: opts.headSha,
    })
  );
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  if (opts.state === "failed") {
    await store.saveResult(leased.id, "worker", { kind: "error", error: opts.error ?? opts.reason ?? "boom" });
    await store.markPublished(leased.id, "worker", { state: "failed", reason: opts.reason ?? opts.error ?? "boom" });
  } else if (opts.state === "skipped") {
    await store.saveResult(leased.id, "worker", { kind: "skip", reason: opts.reason ?? NO_OUTPUT });
    await store.markPublished(leased.id, "worker", { state: "skipped", reason: opts.reason ?? NO_OUTPUT });
  } else {
    await store.saveResult(leased.id, "worker", { kind: "markdown", markdown: opts.markdown ?? "ok" });
    await store.markPublished(leased.id, "worker", { state: "succeeded" });
  }
  return leased.id;
}

function failingVerdictMarkdown(): string {
  const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] });
  expect(
    store.addFinding({ path: "src/a.ts", line: 1, severity: "bug", title: "null deref", body: "Guard it." }).ok
  ).toBe(true);
  expect(store.setVerdict({ state: "failure", reason: "1 blocking" }).ok).toBe(true);
  return store.toMarkdown();
}

function openForge(heads: Map<number, string>, opts: { closed?: Set<number>; missingHead?: Set<number> } = {}) {
  return {
    getPR: async (_owner: string, _repo: string, index: number) => {
      if (opts.closed?.has(index)) return { state: "closed", merged: false, head: { sha: heads.get(index) ?? "" } };
      const sha = heads.get(index);
      if (sha === undefined) throw new Error(`Gitea API → 404 for #${index}`);
      if (opts.missingHead?.has(index)) return { state: "open", merged: false, head: { sha: "" } };
      return { state: "open", merged: false, head: { sha } };
    },
    closePullRequest: async () => undefined,
    reopenPullRequest: async () => undefined,
  };
}

describe("bulk requeue eligibility", () => {
  test("only review failed/skipped no-artifact rows are eligible", () => {
    const base = { kind: "review", resultMarkdown: null, resultJson: undefined, headSha: headFor(7) };
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: NO_OUTPUT, error: null })).toBe(true);
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: NO_FINDINGS, error: null })).toBe(true);
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: NO_CHECK_VERDICT, error: null })).toBe(
      true
    );
    // Failed review with the supported no-artifact outcome is covered.
    expect(isBulkEligibleReviewRow({ ...base, state: "failed", resultReason: null, error: NO_ARTIFACT })).toBe(true);
    // Published verdicts, other kinds, unknown and empty reasons fail closed.
    expect(
      isBulkEligibleReviewRow({ ...base, state: "succeeded", resultReason: null, error: null, failingVerdict: true })
    ).toBe(false);
    expect(
      isBulkEligibleReviewRow({ ...base, kind: "implement", state: "skipped", resultReason: NO_OUTPUT, error: null })
    ).toBe(false);
    expect(
      isBulkEligibleReviewRow({ ...base, kind: "follow-up", state: "failed", resultReason: NO_OUTPUT, error: null })
    ).toBe(false);
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: "blocked on #1", error: null })).toBe(
      false
    );
    expect(
      isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: "waiting-maintainer", error: null })
    ).toBe(false);
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: "boom", error: null })).toBe(false);
    expect(isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: "", error: null })).toBe(false);
    expect(isBulkEligibleReviewRow({ ...base, state: "cancelled", resultReason: NO_OUTPUT, error: null })).toBe(false);
    expect(
      isBulkEligibleReviewRow({ ...base, state: "skipped", resultReason: NO_OUTPUT, error: null, headSha: "" })
    ).toBe(false);
  });
});

describe("bulk requeue board", () => {
  test("mixed fixture marks only eligible rows bulk-eligible and preview excludes the rest", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 7, headSha: headFor(7), state: "skipped", reason: NO_OUTPUT });
    await seedTerminal(store, {
      prNumber: 8,
      headSha: headFor(8),
      state: "failed",
      reason: NO_ARTIFACT,
      error: NO_ARTIFACT,
    });
    await seedTerminal(store, {
      prNumber: 9,
      headSha: headFor(9),
      state: "succeeded",
      markdown: failingVerdictMarkdown(),
    });
    await seedTerminal(store, {
      prNumber: 10,
      headSha: headFor(10),
      state: "skipped",
      reason: "blocked on kirmanak/demo#1",
    });
    const groups = await buildBoardGroups(store);
    const byNumber = new Map(groups.needs_kick.map((item) => [item.number, item]));
    expect(byNumber.get(7)?.bulkEligible).toBe(true);
    expect(byNumber.get(8)?.bulkEligible).toBe(true);
    // The server-marked flag agrees with the typed rule for visible rows.
    for (const item of groups.needs_kick) {
      expect(isBulkEligibleBoardItem(item)).toBe(item.bulkEligible === true);
    }
    // Published verdict rows are grouped apart and never bulk-eligible.
    expect(byNumber.get(9)?.bulkEligible).toBeUndefined();
    expect(byNumber.get(9)?.failingVerdict).toBe(true);
    // Dependency rechecks are not exec-failures and never bulk-eligible.
    expect(byNumber.get(10)?.bulkEligible).toBeUndefined();
    const page = renderBoardPage("catalog-test");
    expect(page).toContain("Select all eligible");
    expect(page).toContain("/api/board/kick/bulk");
  });

  test("bulk submit queues eligible, skips the rest, and replays without double-counting", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 7, headSha: headFor(7), state: "skipped", reason: NO_OUTPUT });
    await seedTerminal(store, {
      prNumber: 8,
      headSha: headFor(8),
      state: "failed",
      reason: NO_ARTIFACT,
      error: NO_ARTIFACT,
    });
    await seedTerminal(store, {
      prNumber: 9,
      headSha: headFor(9),
      state: "succeeded",
      markdown: failingVerdictMarkdown(),
    });
    const heads = new Map([
      [7, headFor(7)],
      [8, headFor(8)],
      [9, headFor(9)],
    ]);
    const handler = createBoardFetchHandler({
      store,
      forgeApi: openForge(heads),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const body = {
      forge: "gitea",
      idempotencyKey: "batch-1",
      items: [
        { owner: "kirmanak", repo: "demo", number: 7, commit: headFor(7), kick: NO_OUTPUT },
        { owner: "kirmanak", repo: "demo", number: 8, commit: headFor(8), kick: NO_ARTIFACT },
        { owner: "kirmanak", repo: "demo", number: 9, commit: headFor(9), kick: "1 blocking" },
      ],
    };
    const first = await handler(bulkRequest(body, { "Idempotency-Key": "batch-1" }));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as Record<string, unknown>;
    const totals = firstJson.totals as Record<string, number>;
    expect(totals).toMatchObject({ queued: 2, skipped: 1, failed: 0 });
    const results = firstJson.results as Array<Record<string, unknown>>;
    expect(results.filter((r) => r.status === "queued")).toHaveLength(2);
    expect(results.find((r) => r.number === 9)?.status).toBe("skipped");
    // Partial success does not report the whole batch as queued.
    expect(totals.queued).toBe(2);
    // Duplicate submit with the same batch key replays without new jobs.
    const queuedBefore = (await store.listInflight(500)).length;
    const replay = await handler(bulkRequest(body, { "Idempotency-Key": "batch-1" }));
    expect(replay.status).toBe(200);
    const replayJson = (await replay.json()) as Record<string, unknown>;
    expect(replayJson.totals).toEqual(firstJson.totals);
    expect((await store.listInflight(500)).length).toBe(queuedBefore);
  });

  test("stale head, closed PR, newer verdict, and running races all skip", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 21, headSha: headFor(21), state: "skipped", reason: NO_OUTPUT });
    await seedTerminal(store, { prNumber: 22, headSha: headFor(22), state: "skipped", reason: NO_OUTPUT });
    // Newer verdict for #23: the latest attempt succeeded, so bulk skips it.
    await seedTerminal(store, {
      prNumber: 23,
      headSha: headFor(23),
      state: "succeeded",
      markdown: "ok <!-- jumi-check: success -->",
    });
    await seedTerminal(store, { prNumber: 24, headSha: headFor(24), state: "skipped", reason: NO_OUTPUT });
    // Same-head retry race: queue a new row for #24 so the candidate conflicts.
    await store.requeueKick({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 24,
      headSha: headFor(24),
      kick: NO_OUTPUT,
      actor: "tester",
      idempotencyKey: "race-24",
      delivery: "race-24",
    });
    const heads = new Map([
      [21, "ffffffffffffffffffffffffffffffffffffffff"],
      [22, headFor(22)],
      [23, headFor(23)],
      [24, headFor(24)],
    ]);
    const handler = createBoardFetchHandler({
      store,
      forgeApi: openForge(heads, { closed: new Set([22]) }),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const res = await handler(
      bulkRequest({
        forge: "gitea",
        idempotencyKey: "batch-races",
        items: [
          { owner: "kirmanak", repo: "demo", number: 21, commit: headFor(21), kick: NO_OUTPUT },
          { owner: "kirmanak", repo: "demo", number: 22, commit: headFor(22), kick: NO_OUTPUT },
          { owner: "kirmanak", repo: "demo", number: 23, commit: headFor(23), kick: NO_OUTPUT },
          { owner: "kirmanak", repo: "demo", number: 24, commit: headFor(24), kick: NO_OUTPUT },
        ],
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const results = json.results as Array<Record<string, unknown>>;
    expect(results.find((r) => r.number === 21)?.code).toBe("superseded");
    expect(results.find((r) => r.number === 22)?.code).toBe("closed");
    expect(results.find((r) => r.number === 23)?.status).toBe("skipped");
    expect(results.find((r) => r.number === 24)?.code).toBe("conflict");
    expect(json.totals).toMatchObject({ queued: 0, skipped: 4, failed: 0 });
  });

  test("live forge failures do not enqueue and unknown forge errors fail the row", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 31, headSha: headFor(31), state: "skipped", reason: NO_OUTPUT });
    await seedTerminal(store, { prNumber: 32, headSha: headFor(32), state: "skipped", reason: NO_OUTPUT });
    const flaky = {
      getPR: async (_o: string, _r: string, index: number) => {
        if (index === 31) throw new Error("boom");
        return { state: "open", merged: false, head: { sha: headFor(32) } };
      },
      closePullRequest: async () => undefined,
      reopenPullRequest: async () => undefined,
    };
    const handler = createBoardFetchHandler({
      store,
      forgeApi: flaky,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const res = await handler(
      bulkRequest({
        forge: "gitea",
        idempotencyKey: "batch-forge",
        items: [
          { owner: "kirmanak", repo: "demo", number: 31, commit: headFor(31), kick: NO_OUTPUT },
          { owner: "kirmanak", repo: "demo", number: 32, commit: headFor(32), kick: NO_OUTPUT },
        ],
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const results = json.results as Array<Record<string, unknown>>;
    expect(results.find((r) => r.number === 31)?.status).toBe("failed");
    expect(results.find((r) => r.number === 32)?.status).toBe("queued");
    expect(json.totals).toMatchObject({ queued: 1, skipped: 0, failed: 1 });
  });

  test("missing forge client refuses to enqueue", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 33, headSha: headFor(33), state: "skipped", reason: NO_OUTPUT });
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const res = await handler(
      bulkRequest({
        forge: "gitea",
        idempotencyKey: "batch-noforge",
        items: [{ owner: "kirmanak", repo: "demo", number: 33, commit: headFor(33), kick: NO_OUTPUT }],
      })
    );
    expect(res.status).toBe(503);
  });

  test("filters, overflow, and cross-forge batches are rejected", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createBoardFetchHandler({
      store,
      forgeApi: openForge(new Map()),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const tooMany = Array.from({ length: BOARD_BULK_MAX_ITEMS + 1 }, (_, i) => ({
      owner: "kirmanak",
      repo: "demo",
      number: 100 + i,
      commit: headFor(100 + i),
      kick: NO_OUTPUT,
    }));
    expect((await handler(bulkRequest({ items: tooMany, idempotencyKey: "x" }))).status).toBe(400);
    expect((await handler(bulkRequest({ items: [], idempotencyKey: "x" }))).status).toBe(400);
    expect(
      (
        await handler(
          bulkRequest({
            forge: "github",
            idempotencyKey: "x",
            items: [{ owner: "a", repo: "b", number: 1, commit: headFor(1), kick: NO_OUTPUT, forge: "gitea" }],
          })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await handler(
          bulkRequest({
            forge: "gitea",
            idempotencyKey: "x",
            items: [{ owner: "kirmanak", repo: "demo", number: 1, commit: headFor(1), kick: NO_OUTPUT }],
          })
        )
      ).status
    ).toBe(200);
  });

  test("authorization and forge isolation hold for bulk", async () => {
    const store = new MemoryReviewJobStore();
    await seedTerminal(store, { prNumber: 41, headSha: headFor(41), state: "skipped", reason: NO_OUTPUT });
    const authed = createBoardFetchHandler({
      store,
      forgeApi: openForge(new Map([[41, headFor(41)]])),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const noIdentity = new Request("https://board.test/api/board/kick/bulk", {
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        items: [{ owner: "kirmanak", repo: "demo", number: 41, commit: headFor(41), kick: NO_OUTPUT }],
        idempotencyKey: "k",
      }),
    });
    expect((await authed(noIdentity)).status).toBe(401);
    const badType = new Request("https://board.test/api/board/kick/bulk", {
      method: "POST",
      headers: new Headers({ "Content-Type": "text/plain", "X-Forwarded-User": "operator" }),
      body: "hi",
    });
    expect((await authed(badType)).status).toBe(400);
    const foreignOrigin = bulkRequest(
      {
        items: [{ owner: "kirmanak", repo: "demo", number: 41, commit: headFor(41), kick: NO_OUTPUT }],
        idempotencyKey: "k2",
      },
      { Origin: "https://evil.test" }
    );
    expect((await authed(foreignOrigin)).status).toBe(403);
    // Peer listener is bearer-only: edge identity alone never authorizes bulk.
    const peer = createBoardFetchHandler({
      store,
      forge: "github",
      peerToken: "peer-secret",
      forgeApi: openForge(new Map([[41, headFor(41)]])),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    expect(
      (
        await peer(
          bulkRequest({
            items: [{ owner: "k", repo: "r", number: 1, commit: headFor(1), kick: NO_OUTPUT }],
            idempotencyKey: "k3",
          })
        )
      ).status
    ).toBe(401);
    const peerOk = await peer(
      new Request("https://board.test/api/board/kick/bulk", {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json", Authorization: "Bearer peer-secret" }),
        body: JSON.stringify({
          items: [{ owner: "kirmanak", repo: "demo", number: 41, commit: headFor(41), kick: NO_OUTPUT }],
          idempotencyKey: "peer-batch-1",
        }),
      })
    );
    expect(peerOk.status).toBe(200);
  });

  test("peer bulk forwards over the bearer hop and is unavailable without a bulk path", async () => {
    const store = new MemoryReviewJobStore();
    const peerBody = {
      ok: true,
      forge: "github",
      batchKey: "b",
      results: [],
      totals: { queued: 0, skipped: 0, failed: 0 },
    };
    const forward = async () =>
      new Response(JSON.stringify(peerBody), { status: 200, headers: { "Content-Type": "application/json" } });
    const handler = createBoardFetchHandler({
      store,
      forgeApi: openForge(new Map()),
      peerUrl: "https://peer.test/",
      peerToken: "peer-secret",
      fetchFn: (async () => forward()) as unknown as typeof fetch,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const res = await handler(
      bulkRequest({
        forge: "github",
        idempotencyKey: "batch-peer",
        items: [{ owner: "kirmanak", repo: "demo", number: 7, commit: headFor(7), kick: NO_OUTPUT }],
      })
    );
    expect(res.status).toBe(200);
    const missing = createBoardFetchHandler({
      store,
      forgeApi: openForge(new Map()),
      peerUrl: "https://peer.test/",
      peerToken: "peer-secret",
      fetchFn: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const res2 = await missing(
      bulkRequest({
        forge: "github",
        idempotencyKey: "batch-peer-2",
        items: [{ owner: "kirmanak", repo: "demo", number: 7, commit: headFor(7), kick: NO_OUTPUT }],
      })
    );
    expect(res2.status).toBe(503);
    const noPeer = createBoardFetchHandler({
      store,
      forgeApi: openForge(new Map()),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const res3 = await noPeer(
      bulkRequest({
        forge: "github",
        idempotencyKey: "batch-peer-3",
        items: [{ owner: "kirmanak", repo: "demo", number: 7, commit: headFor(7), kick: NO_OUTPUT }],
      })
    );
    expect(res3.status).toBe(503);
  });
});
