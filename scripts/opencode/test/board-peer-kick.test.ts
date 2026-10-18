import { describe, expect, test } from "bun:test";
import { BOARD_KICK_CATALOG_VERSION, createBoardFetchHandler, PEER_FORGE, renderBoardPage } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeJob } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function boardRequest(path = "/api/board"): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(EDGE_HEADERS) });
}

function homelabKickRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS, ...headers }),
    body: JSON.stringify(body),
  });
}

async function seedFailed(store: MemoryReviewJobStore, reason = "boom", prNumber = 7, headSha = HEAD_SHA) {
  await store.enqueue(
    makeJob({ delivery: `d-${prNumber}-${headSha.slice(0, 6)}-${reason.slice(0, 4)}`, prNumber, headSha })
  );
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  await store.saveResult(leased.id, "worker", { kind: "error", error: reason });
  await store.markPublished(leased.id, "worker", { state: "failed", reason });
  return leased.id;
}

/** Delegating fetch: homelab hop hits a real peer board handler backed by peerStore. */
function delegatingFetch(
  peerHandler: (req: Request) => Promise<Response>,
  seen: { url: string; auth: string | null; edge: string | null; body: unknown }[]
) {
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    seen.push({
      url,
      auth: headers.get("authorization"),
      edge: headers.get("x-forwarded-user"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const method = (init?.method ?? "GET").toUpperCase();
    const target = url.endsWith("/api/board/kick") ? "https://peer.test/api/board/kick" : "https://peer.test/api/board";
    const req = new Request(target, {
      method,
      headers,
      body: method === "POST" ? (init?.body as string) : undefined,
    });
    return peerHandler(req);
  }) as unknown as typeof fetch;
}

describe("board peer-forge kick forwarding (#272)", () => {
  test("peer requeue row keeps kick on homelab board and renders the button", async () => {
    const peerStore = new MemoryReviewJobStore();
    await seedFailed(peerStore);
    const peerHandler = createBoardFetchHandler({
      store: peerStore,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const seen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const homelabStore = new MemoryReviewJobStore();
    const homelab = createBoardFetchHandler({
      store: homelabStore,
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: delegatingFetch(peerHandler, seen),
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const res = await homelab(boardRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const peer = body.peers[PEER_FORGE] as Record<string, any>;
    expect(peer.available).toBe(true);
    expect(peer.forge).toBe(PEER_FORGE);
    expect(peer.needs_kick).toHaveLength(1);
    const row = peer.needs_kick[0] as Record<string, any>;
    expect(row.forge).toBe(PEER_FORGE);
    expect(row.kick).toMatchObject({ effect: expect.any(String), kick: "boom" });
    expect(typeof row.message).toBe("string");
    expect(row.message).toContain("ready to requeue");

    const html = renderBoardPage(BOARD_KICK_CATALOG_VERSION);
    expect(html).toContain("Requeue review");
    expect(html).toContain("forgeOf(item");
    expect(html).toContain("forge: forgeOf");
    expect(html).not.toContain("isLocalRow");
  });

  test("forwarded peer kick lands in peer store, not homelab, with bearer and kick log", async () => {
    const peerStore = new MemoryReviewJobStore();
    const terminalId = await seedFailed(peerStore);
    const peerHandler = createBoardFetchHandler({
      store: peerStore,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const seen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const logs: string[] = [];
    const homelabStore = new MemoryReviewJobStore();
    const homelab = createBoardFetchHandler({
      store: homelabStore,
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: delegatingFetch(peerHandler, seen),
      getGrantNotice: () => undefined,
      logger: (m: string) => logs.push(m),
    });

    const ok = await homelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
        idempotencyKey: "peer-1",
      })
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, any>;
    expect(okBody.terminalJobId).toBe(terminalId);

    // Peer store grew, homelab job store did not.
    expect((await peerStore.listInflight()).length).toBeGreaterThan(0);
    expect(await homelabStore.listInflight()).toHaveLength(0);
    // Hop used the bearer, pinned kick URL, and never forwarded edge identity.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://peer.internal/api/board/kick");
    expect(seen[0].auth).toBe("Bearer s3cret");
    expect(seen[0].edge).toBeNull();
    expect(seen[0].body).not.toHaveProperty("forge");
    expect(seen[0].body).not.toHaveProperty("actor");
    // Homelab kick log records actor, forge, coordinates, and result.
    const logged = await homelabStore.getKickByIdempotencyKey("peer-1");
    expect(logged).toMatchObject({ actor: "operator", owner: "kirmanak", repo: "demo", number: 7 });
    expect(logged?.result).toBe("peer-ok");
    expect(logs.join("\n")).toContain("forge=github");
    expect(logs.join("\n")).toContain("actor=operator");

    // Same key replays from the homelab log without a second hop.
    const replay = await homelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
        idempotencyKey: "peer-1",
      })
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Record<string, any>).deduped).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test("peer 409/422/timeout/unavailable reach the page as errors", async () => {
    const peerStore = new MemoryReviewJobStore();
    await seedFailed(peerStore);
    const peerHandler = createBoardFetchHandler({
      store: peerStore,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const seen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const homelabStore = new MemoryReviewJobStore();
    const homelab = createBoardFetchHandler({
      store: homelabStore,
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: delegatingFetch(peerHandler, seen),
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    const stale = await homelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "wrong",
        forge: "github",
      })
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Record<string, any>).code).toBe("stale-kick");

    const disabledStore = new MemoryReviewJobStore();
    await seedFailed(disabledStore, "provider auth death");
    const disabledPeer = createBoardFetchHandler({
      store: disabledStore,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const disabledSeen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const disabledHomelab = createBoardFetchHandler({
      store: new MemoryReviewJobStore(),
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: delegatingFetch(disabledPeer, disabledSeen),
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const notKickable = await disabledHomelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "provider auth death",
        forge: "github",
      })
    );
    expect(notKickable.status).toBe(422);
    expect(((await notKickable.json()) as Record<string, any>).code).toBe("not-kickable");

    const timeoutHomelab = createBoardFetchHandler({
      store: new MemoryReviewJobStore(),
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: (async () => {
        throw new Error("peer timed out");
      }) as unknown as typeof fetch,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const timeout = await timeoutHomelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
      })
    );
    expect(timeout.status).toBe(503);
    expect(((await timeout.json()) as Record<string, any>).error).toBe("peer unavailable");

    const noPeer = createBoardFetchHandler({
      store: new MemoryReviewJobStore(),
      forge: "gitea",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const unavailable = await noPeer(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
      })
    );
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as Record<string, any>).error).toBe("peer unavailable");

    // The page surfaces the 503 detail instead of a fake success.
    expect(renderBoardPage(BOARD_KICK_CATALOG_VERSION)).toContain("503");
  });

  test("forwarded kick cannot target a local row; crafted forge/URL cannot redirect the hop", async () => {
    const peerStore = new MemoryReviewJobStore();
    const peerHandler = createBoardFetchHandler({
      store: peerStore,
      forge: "github",
      peerToken: "s3cret",
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const seen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const homelabStore = new MemoryReviewJobStore();
    await seedFailed(homelabStore);
    const homelab = createBoardFetchHandler({
      store: homelabStore,
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: delegatingFetch(peerHandler, seen),
      getGrantNotice: () => undefined,
      logger: () => {},
    });

    // Peer has no such row: the forward 404s and the local terminal is untouched.
    const miss = await homelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
      })
    );
    expect(miss.status).toBe(404);
    expect(await homelabStore.listInflight()).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://peer.internal/api/board/kick");

    // Crafted forges never forward: they stay local and never hit the hop.
    for (const forge of ["evil", "gitea", "GITHUB", "https://evil.test", "github ", ""]) {
      const before = seen.length;
      const body: Record<string, unknown> = { owner: "kirmanak", repo: "demo", number: 7 };
      if (forge !== "") body.forge = forge;
      if (forge === "github ") body.commit = HEAD_SHA;
      if (forge === "github ") (body as Record<string, unknown>).kick = "boom";
      await homelab(homelabKickRequest(body));
      // "github " trims to github and does forward; every other value must not.
      if (forge === "github ") {
        expect(seen.length).toBe(before + 1);
      } else {
        expect(seen.length).toBe(before);
      }
    }

    // A body URL field cannot redirect the hop: only the server peerUrl is used.
    const evil = await homelab(
      homelabKickRequest({
        owner: "kirmanak",
        repo: "demo",
        number: 7,
        commit: HEAD_SHA,
        kick: "boom",
        forge: "github",
        peerUrl: "https://evil.test/kick",
        url: "https://evil.test/kick",
      })
    );
    expect([200, 404, 409, 422, 503]).toContain(evil.status);
    for (const entry of seen) {
      expect(entry.url).toBe("https://peer.internal/api/board/kick");
      expect(entry.url).not.toContain("evil.test");
    }
  });

  test("local-row kicks are unchanged and never hit the hop", async () => {
    const seen: { url: string; auth: string | null; edge: string | null; body: unknown }[] = [];
    const homelabStore = new MemoryReviewJobStore();
    await seedFailed(homelabStore);
    const homelab = createBoardFetchHandler({
      store: homelabStore,
      forge: "gitea",
      peerUrl: "https://peer.internal/api/board",
      peerToken: "s3cret",
      fetchFn: (async () => {
        throw new Error("must not forward local kicks");
      }) as unknown as typeof fetch,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    void seen;

    const ok = await homelab(
      homelabKickRequest({ owner: "kirmanak", repo: "demo", number: 7, commit: HEAD_SHA, kick: "boom" })
    );
    expect(ok.status).toBe(200);
    expect(await homelabStore.listInflight()).toHaveLength(1);
  });
});
