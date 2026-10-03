import { describe, expect, test } from "bun:test";
import {
  BOARD_KICK_CATALOG_VERSION,
  BOARD_PEER_TOKEN_ENV,
  BOARD_PEER_URL_ENV,
  buildBoardGroups,
  createBoardFetchHandler,
  PEER_BOARD_MAX_BYTES,
  PEER_FORGE,
  renderBoardPage,
} from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { createFetchHandler } from "../src/server.ts";
import { makeConfig, makeIssueJob, makeJob } from "./fixtures.ts";

function boardRequest(path = "/api/board", headers: Record<string, string> = {}): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(headers) });
}

function kickRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...headers }),
    body: JSON.stringify(body),
  });
}

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

async function seedStore(): Promise<MemoryReviewJobStore> {
  const store = new MemoryReviewJobStore();
  await store.enqueue(makeJob({ delivery: "d-1", prNumber: 7, headSha: "abc123" }));
  await store.enqueueIssue(makeIssueJob({ delivery: "d-2", issueNumber: 12 }));
  // Sits use numbers that do not collide with the enqueued rows above,
  // since enqueue clears the sit for its own number.
  await store.sits.remember("kirmanak", "demo", 21, "ci-not-completed");
  await store.sits.remember("kirmanak", "demo", 22, "no-changes");
  return store;
}

describe("operator board read API", () => {
  test("401 without edge identity, including signature-only", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    const missing = await handler(boardRequest());
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const signatureOnly = await handler(
      boardRequest("/api/board", {
        "X-Gitea-Signature": "deadbeef",
        Authorization: "Bearer webhook-secret",
      })
    );
    expect(signatureOnly.status).toBe(401);
  });

  test("200 group split with kick present/omitted and commit omitted when unknown", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forge: "gitea",
      forgeUrl: "https://gitea.example",
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;

    const inProgress = body.in_progress as Record<string, unknown>[];
    const needsKick = body.needs_kick as Record<string, unknown>[];
    const sitting = body.sitting as Record<string, unknown>[];

    expect(inProgress).toHaveLength(2);
    expect(needsKick).toHaveLength(1);
    expect(sitting).toHaveLength(1);

    // Ledger rows carry no kick button.
    for (const item of inProgress) expect(item).not.toHaveProperty("kick");
    // Kickable sit carries a server-provided effect; terminal sit carries none.
    expect(needsKick[0]).toMatchObject({ reason: "ci-not-completed", kick: { effect: expect.any(String) } });
    expect(Object.keys(needsKick[0].kick as object).sort()).toEqual(["effect", "kick"]);
    expect(sitting[0]).toMatchObject({ reason: "no-changes" });
    expect(sitting[0]).not.toHaveProperty("kick");

    // Commit known on the review row, omitted on the issue row with no head SHA.
    const withCommit = inProgress.find((item) => item.number === 7);
    expect(withCommit).toMatchObject({ commit: "abc123", headSha: "abc123" });
    const withoutCommit = inProgress.find((item) => item.number === 12);
    expect(withCommit).toBeDefined();
    expect(withoutCommit).toBeDefined();
    expect(withoutCommit).not.toHaveProperty("commit");
    expect(withoutCommit).not.toHaveProperty("headSha");

    // No tokens, secrets, or raw payloads leak into items.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("bot-token");
    expect(raw).not.toContain("webhook-secret");
    for (const item of [...inProgress, ...needsKick, ...sitting]) {
      expect(item).not.toHaveProperty("payload");
      expect(item).not.toHaveProperty("resultMarkdown");
    }

    // CamelCase aliases match by value but share no reference with the canonical groups.
    expect(body.inProgress).toEqual(inProgress);
    expect(body.needsKick).toEqual(needsKick);
    expect(body.sitting_on_purpose).toEqual(sitting);
    expect(body.inProgress).not.toBe(inProgress);
    expect(body.needsKick).not.toBe(needsKick);
    expect(body.sitting_on_purpose).not.toBe(sitting);

    // Same-origin page metadata: forge, forge origin, and kick catalog.
    expect(body.forge).toBe("gitea");
    expect(body.forgeUrl).toBe("https://gitea.example");
    expect(body.catalog).toBe(BOARD_KICK_CATALOG_VERSION);
    for (const item of [...inProgress, ...needsKick, ...sitting]) {
      expect(item.forge).toBe("gitea");
    }

    // Single trailing slash serves instead of 404.
    const slashed = await handler(boardRequest("/api/board/", EDGE_HEADERS));
    expect(slashed.status).toBe(200);
  });

  test("buildBoardGroups splits sits without per-row forge calls", async () => {
    const store = await seedStore();
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(2);
    expect(groups.needs_kick.map((item) => item.reason)).toEqual(["ci-not-completed"]);
    expect(groups.sitting.map((item) => item.reason)).toEqual(["no-changes"]);
  });

  test("board paths stay 404 on the webhook host", async () => {
    const handler = createFetchHandler(makeConfig(), {
      queue: {
        enqueue: () => ({ key: "k", queued: true }),
      },
    });
    expect((await handler(new Request("https://reviewer.test/board"))).status).toBe(404);
    expect((await handler(new Request("https://reviewer.test/api/board"))).status).toBe(404);
  });

  test("HEAD on board paths is 405 without touching the ledger", async () => {
    const failing = {
      listInflight: async (): Promise<never[]> => {
        throw new Error("db down");
      },
      sits: {
        list: async () => {
          throw new Error("db down");
        },
      },
    };
    const handler = createBoardFetchHandler({
      store: failing as unknown as MemoryReviewJobStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const response = await handler(
      new Request("https://board.test/api/board", { method: "HEAD", headers: new Headers(EDGE_HEADERS) })
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("ledger failure is 503 with no cached list", async () => {
    const failing = {
      listInflight: async (): Promise<never[]> => {
        throw new Error("db down");
      },
      sits: { list: async () => [] },
    };
    const handler = createBoardFetchHandler({
      store: failing as unknown as MemoryReviewJobStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "queue unavailable" });
  });

  test("peer env constants stay in sync with loadConfig literals", async () => {
    // loadConfig must keep string literals so the deploy-contract gate can
    // statically resolve them; this pins the two sides together instead.
    expect(BOARD_PEER_URL_ENV).toBe("BOARD_PEER_URL");
    expect(BOARD_PEER_TOKEN_ENV).toBe("BOARD_PEER_TOKEN");
  });

  test("peer listener is bearer-only and ignores forwarded edge headers", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({
      store,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const forged = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(forged.status).toBe(401);

    const bearer = await handler(boardRequest("/api/board", { Authorization: "Bearer s3cret" }));
    expect(bearer.status).toBe(200);
    const body = (await bearer.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ forge: "github", peers: {} });
  });

  test("homelab never accepts the bearer without edge identity", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({
      store,
      peerToken: "s3cret",
      peerUrl: "https://peer.internal/board",
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const bearerOnly = await handler(boardRequest("/api/board", { Authorization: "Bearer s3cret" }));
    expect(bearerOnly.status).toBe(401);
  });

  test("unset peer hop is unavailable without a fetch", async () => {
    const store = await seedStore();
    let called = false;
    const handler = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      fetchFn: (async () => {
        called = true;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const peers = body.peers as Record<string, Record<string, unknown>>;
    expect(called).toBe(false);
    expect(peers[PEER_FORGE]).toMatchObject({ available: false, forge: PEER_FORGE });
  });

  test("spoofed peer forge stays under peers.github with pinned row forges", async () => {
    const store = await seedStore();
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          forge: "gitea",
          in_progress: [{ reason: "review leased", owner: "o", repo: "r", number: 1, kind: "review", forge: "gitea" }],
          needs_kick: [],
          sitting: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;
    const handler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn,
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.forge).toBe("gitea");
    expect(Object.keys(body.peers as object)).toEqual([PEER_FORGE]);
    const peer = (body.peers as Record<string, Record<string, unknown>>)[PEER_FORGE];
    expect(peer).toMatchObject({ available: true, forge: PEER_FORGE });
    const rows = peer.in_progress as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].forge).toBe(PEER_FORGE);
    // Top-level lists stay local-only: the peer row is not merged there.
    const local = body.in_progress as unknown[];
    expect(local).toHaveLength(2);
  });

  test("unreachable peer falls back to unavailable without failing the board", async () => {
    const store = await seedStore();
    const fetchFn = (async () => {
      throw new Error("peer down");
    }) as unknown as typeof fetch;
    const handler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn,
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const peers = body.peers as Record<string, Record<string, unknown>>;
    expect(peers[PEER_FORGE]).toMatchObject({ available: false, forge: PEER_FORGE });
  });

  test("chunked peer body without Content-Length is capped while streaming", async () => {
    const store = await seedStore();
    const chunkSize = 256 * 1024;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    // A test double, not a real Response: no Content-Length, and text()
    // throws so the cap must trip on the streamed bytes alone.
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: stream,
      text: async () => {
        throw new Error("peer body must not be buffered with text()");
      },
    })) as unknown as typeof fetch;
    const handler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn,
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const peers = body.peers as Record<string, Record<string, unknown>>;
    expect(peers[PEER_FORGE]).toMatchObject({ available: false, forge: PEER_FORGE });
    expect(cancelled).toBe(true);
    // Reading stops just past the cap instead of draining the endless body.
    expect(pulled * chunkSize).toBeLessThanOrEqual(PEER_BOARD_MAX_BYTES + 2 * chunkSize);
  });

  test("chunked peer body under the cap still loads without Content-Length", async () => {
    const store = await seedStore();
    const payload = new TextEncoder().encode(
      JSON.stringify({
        in_progress: [{ reason: "review leased", owner: "o", repo: "r", number: 3, kind: "review" }],
        needs_kick: [],
        sitting: [],
      })
    );
    const half = Math.floor(payload.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, half));
        controller.enqueue(payload.slice(half));
        controller.close();
      },
    });
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: stream,
      text: async () => {
        throw new Error("peer body must not be buffered with text()");
      },
    })) as unknown as typeof fetch;
    const handler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn,
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const peer = (body.peers as Record<string, Record<string, unknown>>)[PEER_FORGE];
    expect(peer).toMatchObject({ available: true, forge: PEER_FORGE });
    expect(peer.in_progress as unknown[]).toHaveLength(1);
  });

  test("page is served with the board on the same origin", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    for (const path of ["/", "/board", "/board/"]) {
      const response = await handler(boardRequest(path, EDGE_HEADERS));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const html = await response.text();
      // Two lists on the phone; reason is the headline elsewhere via payload.
      expect(html).toContain("<h2>In progress</h2>");
      expect(html).toContain("<h2>Sitting</h2>");
      // Forge switch, inspector, and phone sheet.
      expect(html).toContain('id="forge-switch"');
      expect(html).toContain('id="inspector"');
      expect(html).toContain('id="sheet"');
      // Confirm names the side effect; consequence is a note; one primary control per confirm.
      expect(html).toContain("This will:");
      expect(html).toContain("consequence");
      // Same origin: the browser talks to /api/board, never to the forge.
      expect(html).toContain('fetch("/api/board"');
      expect(html).toContain('fetch("/api/board/kick"');
      expect(html).not.toContain('fetch("http');
      expect(html).not.toContain("fetch('http");
      // No generic action label.
      expect(html.toLowerCase()).not.toContain("retry");
      // Tablet is list plus detail, not a centered phone column.
      expect(html).toContain("@media (min-width: 700px)");
      expect(html).toContain("@media (min-width: 1100px)");
      // Cache-busted with the image catalog.
      expect(html).toContain(BOARD_KICK_CATALOG_VERSION);
      expect(renderBoardPage(BOARD_KICK_CATALOG_VERSION)).toContain(BOARD_KICK_CATALOG_VERSION);
    }

    const anon = await handler(boardRequest("/board", {}));
    expect(anon.status).toBe(401);
  });

  test("kick the server did not send cannot be clicked", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    // Sitting on purpose has no kick.
    const sittingGone = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 22 }, EDGE_HEADERS));
    expect(sittingGone.status).toBe(409);

    // Unknown row has no kick.
    const missing = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 99 }, EDGE_HEADERS));
    expect(missing.status).toBe(404);

    // In-progress rows carry no kick button, so kicking them 404s.
    const inflight = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 7 }, EDGE_HEADERS));
    expect(inflight.status).toBe(404);

    // Bad payload and missing identity fail closed.
    expect((await handler(kickRequest({ owner: "", repo: "demo", number: 21 }, EDGE_HEADERS))).status).toBe(400);
    expect((await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 21 }, {}))).status).toBe(401);
    expect((await handler(new Request("https://board.test/api/board/kick", { method: "GET" }))).status).toBe(405);
  });

  test("kickable sit clears only after an explicit confirm POST", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    const ok = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 21 }, EDGE_HEADERS));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody).toMatchObject({ ok: true, owner: "kirmanak", repo: "demo", number: 21 });

    // Second confirm finds nothing: nothing auto-lands twice.
    const again = await handler(kickRequest({ owner: "kirmanak", repo: "demo", number: 21 }, EDGE_HEADERS));
    expect(again.status).toBe(404);

    const board = (await (await handler(boardRequest("/api/board", EDGE_HEADERS))).json()) as { needs_kick: unknown[] };
    expect(board.needs_kick).toHaveLength(0);
  });
});
