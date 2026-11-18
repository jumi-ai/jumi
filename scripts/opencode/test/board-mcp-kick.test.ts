import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type BoardPullForge, createBoardFetchHandler } from "../src/board.ts";
import { BOARD_MCP_KICK_ACTOR, BOARD_MCP_KICK_TOKEN_ENV } from "../src/board_mcp.ts";
import { reviewJobKey } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeIssueJob, makeJob, makeLinkedIssue } from "./fixtures.ts";

const READ_TOKEN = "mcp-read-token";
const KICK_TOKEN = "mcp-kick-token";
const PEER_TOKEN = "peer-secret-token";
const BOT_TOKEN = "planted-bot-token-xyz";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

function makeHandler(
  store: MemoryReviewJobStore,
  logs: string[],
  opts: {
    mcpToken?: string;
    mcpKickToken?: string;
    peerToken?: string;
    forge?: string;
    forgeApi?: BoardPullForge;
  } = {}
): (request: Request) => Promise<Response> {
  return createBoardFetchHandler({
    store,
    getGrantNotice: () => undefined,
    logger: (message: string) => {
      logs.push(message);
    },
    forge: opts.forge,
    ...(opts.mcpToken !== undefined ? { mcpToken: opts.mcpToken } : { mcpToken: READ_TOKEN }),
    ...(opts.mcpKickToken !== undefined ? { mcpKickToken: opts.mcpKickToken } : { mcpKickToken: KICK_TOKEN }),
    ...(opts.peerToken !== undefined ? { peerToken: opts.peerToken } : {}),
    ...(opts.forgeApi !== undefined ? { forgeApi: opts.forgeApi } : {}),
    mcpSecrets: [BOT_TOKEN, "webhook-secret", PEER_TOKEN, READ_TOKEN, KICK_TOKEN],
  });
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://board.test/mcp", {
    method,
    headers: new Headers({ "Content-Type": "application/json", ...headers }),
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

function mcpText(result: unknown): string {
  const rec = result as { content?: Array<{ type?: string; text?: string }> };
  const first = rec.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("expected text content");
  return first.text;
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function seedFailedReview(
  store: MemoryReviewJobStore,
  opts: { prNumber?: number; headSha?: string; reason?: string } = {}
): Promise<{ terminalId: number; commit: string; kick: string }> {
  const prNumber = opts.prNumber ?? 7;
  const headSha = opts.headSha ?? "abc123";
  const reason = opts.reason ?? "boom";
  const job = makeJob({ delivery: `d-${prNumber}-${headSha}`, prNumber, headSha });
  await store.enqueue(job);
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a review lease");
  await store.saveResult(leased.id, "worker", { kind: "error", error: reason });
  await store.markPublished(leased.id, "worker", { state: "failed", reason });
  return { terminalId: leased.id, commit: headSha, kick: reason };
}

async function seedBlockedImplement(store: MemoryReviewJobStore, reason = "blocked on #196"): Promise<number> {
  await store.enqueueIssue(makeIssueJob({ delivery: `d-blocked-${reason}`, issueNumber: 12 }));
  const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
  if (!leased) throw new Error("expected an implement lease");
  await store.saveResult(leased.id, "worker", { kind: "skip", reason });
  await store.markPublished(leased.id, "worker", { state: "skipped", reason });
  await store.sits.remember("kirmanak", "demo", 12, "no-changes");
  return leased.id;
}

function blockedForge(labelCalls: string[]) {
  return {
    getPR: async () => ({ state: "closed", merged: false, head: { sha: "deadbeef" } }),
    closePullRequest: async () => ({}),
    reopenPullRequest: async () => ({}),
    addIssueLabel: async (_o: string, _r: string, _n: number, label: string) => {
      labelCalls.push(label);
      return {};
    },
    listIssueDependencies: async (_o: string, _r: string, index: number) =>
      index === 12 ? [makeLinkedIssue({ number: 196, state: "closed" })] : [],
    listOpenPulls: async () => [],
  };
}

function reopenForge(calls: string[]) {
  return {
    getPR: async () => ({ state: "closed", merged: false, head: { sha: "deadbeef" } }),
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

async function seedStuck(store: MemoryReviewJobStore): Promise<number> {
  await store.enqueueIssue(makeIssueJob({ delivery: "d-stuck", mode: "follow-up", prNumber: 7, headSha: "abc123" }));
  const leased = await store.lease("worker", 60_000, new Date(), ["follow-up"]);
  if (!leased) throw new Error("expected a follow-up lease");
  await store.saveResult(leased.id, "worker", { kind: "skip", reason: "stuck: too many follow-up rounds" });
  await store.markPublished(leased.id, "worker", { state: "skipped", reason: "stuck: too many follow-up rounds" });
  await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: too many follow-up rounds");
  await store.sits.remember("kirmanak", "demo", 12, "implement-latch");
  return leased.id;
}

function kickRequest(body: Record<string, unknown>): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS }),
    body: JSON.stringify(body),
  });
}

async function mcpCall(
  handler: (request: Request) => Promise<Response>,
  token: string,
  tool: string,
  args: Record<string, unknown>
): Promise<{ result: unknown; logs: string[] }> {
  const logs: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    await client.close();
    return { result, logs };
  } finally {
    server.stop(true);
  }
}

describe("board MCP kick tool (#669)", () => {
  test("kick token env and actor constants", () => {
    expect(BOARD_MCP_KICK_TOKEN_ENV).toBe("BOARD_MCP_KICK_TOKEN");
    expect(BOARD_MCP_KICK_ACTOR).toBe("board-mcp");
  });

  test("tools/list: read token lists exactly the three read tools; kick token adds kick", async () => {
    const store = new MemoryReviewJobStore();
    const handler = makeHandler(store, []);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const readTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
      });
      const readClient = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
      await readClient.connect(readTransport);
      const readListed = await readClient.listTools();
      expect(readListed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "runners"]);
      await readClient.close();

      const kickTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${KICK_TOKEN}` } },
      });
      const kickClient = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
      await kickClient.connect(kickTransport);
      const kickListed = await kickClient.listTools();
      expect(kickListed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "kick", "runners"]);
      await kickClient.close();
    } finally {
      server.stop(true);
    }
  });

  test("kick with the read token is a tool error, never a kick", async () => {
    const store = new MemoryReviewJobStore();
    await store.sits.remember("kirmanak", "demo", 7, "not-labeled");
    const rowsBefore = [...store.rows].length;
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const { result } = await mcpCall(handler, READ_TOKEN, "kick", {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: "sit-clear",
    });
    expect(isErrorResult(result)).toBe(true);
    // No ledger change and no kick-log row.
    expect([...store.rows]).toHaveLength(rowsBefore);
    expect(await store.sits.get("kirmanak", "demo", 7)).toBeDefined();
    expect(await store.listKickLog(500)).toHaveLength(0);
    for (const line of logs) {
      expect(line).not.toContain(READ_TOKEN);
      expect(line).not.toContain(KICK_TOKEN);
    }
  });

  test("kick token unset: kick not listed for any bearer; /mcp otherwise unchanged", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-1", prNumber: 7, headSha: "abc123" }));
    const bare = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      mcpToken: READ_TOKEN,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: bare });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "runners"]);
      const board = await client.callTool({ name: "board", arguments: {} });
      expect(isErrorResult(board)).toBe(false);
      await client.close();
    } finally {
      server.stop(true);
    }
    // Any other bearer is still 401.
    expect(
      (await bare(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, bearer("some-other-token"))))
        .status
    ).toBe(401);
    // /api/board is unchanged.
    const board = await bare(
      new Request("https://board.test/api/board", { method: "GET", headers: new Headers(EDGE_HEADERS) })
    );
    expect(board.status).toBe(200);
  });

  test("kick token equal to the read token or the peer token: tool not armed", async () => {
    const sameAsReadLogs: string[] = [];
    const sameAsRead = makeHandler(new MemoryReviewJobStore(), sameAsReadLogs, { mcpKickToken: READ_TOKEN });
    expect(sameAsReadLogs).toHaveLength(1);
    expect(sameAsReadLogs[0]).toContain("board mcp kick disabled");
    expect(sameAsReadLogs[0]).toContain("read token");
    expect(sameAsReadLogs[0]).not.toContain(READ_TOKEN);

    const sameAsPeerLogs: string[] = [];
    const sameAsPeer = makeHandler(new MemoryReviewJobStore(), sameAsPeerLogs, {
      peerToken: PEER_TOKEN,
      mcpKickToken: PEER_TOKEN,
    });
    expect(sameAsPeerLogs).toHaveLength(1);
    expect(sameAsPeerLogs[0]).toContain("board mcp kick disabled");
    expect(sameAsPeerLogs[0]).toContain("peer token");
    expect(sameAsPeerLogs[0]).not.toContain(PEER_TOKEN);

    for (const handler of [sameAsRead, sameAsPeer]) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
        });
        const client = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "runners"]);
        await client.close();
      } finally {
        server.stop(true);
      }
    }
    // The peer bearer still authenticates neither read nor kick.
    expect(
      (await sameAsPeer(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, bearer(PEER_TOKEN))))
        .status
    ).toBe(401);
  });

  test("edge identity headers alone are 401 when the kick token is armed", async () => {
    const store = new MemoryReviewJobStore();
    const handler = makeHandler(store, []);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await handler(mcpRequest(init, EDGE_HEADERS))).status).toBe(401);
    // Same behaviour on the peer forge.
    const github = makeHandler(store, [], { forge: "github" });
    expect((await github(mcpRequest(init, EDGE_HEADERS))).status).toBe(401);
  });

  test("sit-clear through MCP matches the HTTP route, ledger and response", async () => {
    const seed = async (store: MemoryReviewJobStore): Promise<void> => {
      await store.sits.remember("kirmanak", "demo", 7, "not-labeled");
    };
    const httpStore = new MemoryReviewJobStore();
    await seed(httpStore);
    const httpHandler = createBoardFetchHandler({
      store: httpStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const httpRes = await httpHandler(kickRequest({ owner: "kirmanak", repo: "demo", number: 7 }));
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as Record<string, unknown>;

    const mcpStore = new MemoryReviewJobStore();
    await seed(mcpStore);
    const logs: string[] = [];
    const mcpHandler = makeHandler(mcpStore, logs);
    const { result } = await mcpCall(mcpHandler, KICK_TOKEN, "kick", {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: "sit-clear",
    });
    expect(isErrorResult(result)).toBe(false);
    const mcpBody = JSON.parse(mcpText(result)) as Record<string, unknown>;
    expect(mcpBody).toEqual(httpBody);
    expect(await mcpStore.sits.get("kirmanak", "demo", 7)).toBeUndefined();
    expect(await mcpStore.listKickLog(500)).toHaveLength(0);
    const kickLines = logs.filter((line) => line.startsWith("[board-mcp] tool=kick"));
    expect(kickLines).toHaveLength(1);
    expect(kickLines[0]).toMatch(/^\[board-mcp\] tool=kick kirmanak\/demo#7 kick="sit-clear" result=ok ms=\d+$/);
  });

  test("requeue through MCP matches the HTTP route, ledger and response", async () => {
    const seed = async (store: MemoryReviewJobStore) => seedFailedReview(store, { reason: "boom" });
    const httpStore = new MemoryReviewJobStore();
    const httpSeed = await seed(httpStore);
    const httpHandler = createBoardFetchHandler({
      store: httpStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const httpItem = { owner: "kirmanak", repo: "demo", number: 7, kick: httpSeed.kick, commit: httpSeed.commit };
    const httpRes = await httpHandler(kickRequest(httpItem));
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as Record<string, unknown>;

    const mcpStore = new MemoryReviewJobStore();
    const mcpSeed = await seed(mcpStore);
    expect(mcpSeed.terminalId).toBe(httpSeed.terminalId);
    const logs: string[] = [];
    const mcpHandler = makeHandler(mcpStore, logs);
    const { result } = await mcpCall(mcpHandler, KICK_TOKEN, "kick", {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: mcpSeed.kick,
      commit: mcpSeed.commit,
    });
    expect(isErrorResult(result)).toBe(false);
    const mcpBody = JSON.parse(mcpText(result)) as Record<string, unknown>;
    expect(mcpBody).toEqual(httpBody);
    // Same ledger effect: one queued row on the same commit with the same key.
    const queued = await mcpStore.get(mcpBody.jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.headSha).toBe("abc123");
    expect(queued?.jobKey).toBe(reviewJobKey({ ...makeJob({ prNumber: 7, headSha: "abc123" }) }));
    const kickLog = (await mcpStore.listKickLog(500)).filter((entry) => entry.number === 7);
    expect(kickLog).toHaveLength(1);
    expect(kickLog[0]).toMatchObject({ actor: "board-mcp", result: "ok" });
    const kickLines = logs.filter((line) => line.startsWith("[board-mcp] tool=kick"));
    expect(kickLines).toHaveLength(1);
    expect(kickLines[0]).toMatch(/^\[board-mcp\] tool=kick kirmanak\/demo#7 kick="boom" result=ok ms=\d+$/);
  });

  test("reopen through MCP matches the HTTP route, ledger and response", async () => {
    const httpCalls: string[] = [];
    const httpStore = new MemoryReviewJobStore();
    const httpHandler = createBoardFetchHandler({
      store: httpStore,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: reopenForge(httpCalls),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 7, kick: "reopen" };
    const httpRes = await httpHandler(kickRequest(item));
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as Record<string, unknown>;

    const mcpCalls: string[] = [];
    const mcpStore = new MemoryReviewJobStore();
    const logs: string[] = [];
    const mcpHandler = makeHandler(mcpStore, logs, { forgeApi: reopenForge(mcpCalls) });
    const { result } = await mcpCall(mcpHandler, KICK_TOKEN, "kick", { ...item });
    expect(isErrorResult(result)).toBe(false);
    const mcpBody = JSON.parse(mcpText(result)) as Record<string, unknown>;
    expect(mcpBody).toEqual(httpBody);
    expect(mcpBody).toMatchObject({ ok: true, reopened: true, deduped: false });
    expect(mcpCalls).toEqual(httpCalls);
    expect(mcpCalls).toEqual(["close", "reopen"]);
    const kickLog = (await mcpStore.listKickLog(500)).filter((entry) => entry.number === 7);
    expect(kickLog).toHaveLength(1);
    expect(kickLog[0]).toMatchObject({ actor: "board-mcp", kick: "reopen", result: "ok" });
  });

  test("implement (blocked on) through MCP matches the HTTP route, ledger and response", async () => {
    const seed = seedBlockedImplement;
    const httpLabels: string[] = [];
    const httpStore = new MemoryReviewJobStore();
    const httpTerminal = await seed(httpStore);
    const httpHandler = createBoardFetchHandler({
      store: httpStore,
      getGrantNotice: () => undefined,
      logger: () => {},
      forgeApi: blockedForge(httpLabels),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 12, kick: "implement" };
    const httpRes = await httpHandler(kickRequest(item));
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as Record<string, unknown>;

    const mcpLabels: string[] = [];
    const mcpStore = new MemoryReviewJobStore();
    const mcpTerminal = await seed(mcpStore);
    expect(mcpTerminal).toBe(httpTerminal);
    const logs: string[] = [];
    const mcpHandler = makeHandler(mcpStore, logs, { forgeApi: blockedForge(mcpLabels) });
    const { result } = await mcpCall(mcpHandler, KICK_TOKEN, "kick", { ...item });
    expect(isErrorResult(result)).toBe(false);
    const mcpBody = JSON.parse(mcpText(result)) as Record<string, unknown>;
    expect(mcpBody).toEqual(httpBody);
    expect(mcpBody.terminalJobId).toBe(httpTerminal);
    expect(mcpBody.deduped).toBe(false);
    expect(mcpLabels).toEqual(httpLabels);
    expect(mcpLabels).toEqual(["jumi"]);
    const queued = await mcpStore.get(mcpBody.jobId as number);
    expect(queued?.state).toBe("queued");
    expect(queued?.jobKey).toBe("implement:kirmanak/demo#12");
    const kickLog = (await mcpStore.listKickLog(500)).filter((entry) => entry.number === 12);
    expect(kickLog).toHaveLength(1);
    expect(kickLog[0]).toMatchObject({ actor: "board-mcp", kick: "implement", result: "ok" });
  });

  test("stuck through MCP matches the HTTP route, ledger and response", async () => {
    const httpStore = new MemoryReviewJobStore();
    const httpTerminal = await seedStuck(httpStore);
    const httpHandler = createBoardFetchHandler({
      store: httpStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const item = { owner: "kirmanak", repo: "demo", number: 12, kick: "stuck" };
    const httpRes = await httpHandler(kickRequest(item));
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as Record<string, unknown>;

    const mcpStore = new MemoryReviewJobStore();
    const mcpTerminal = await seedStuck(mcpStore);
    expect(mcpTerminal).toBe(httpTerminal);
    const logs: string[] = [];
    const mcpHandler = makeHandler(mcpStore, logs);
    const { result } = await mcpCall(mcpHandler, KICK_TOKEN, "kick", { ...item });
    expect(isErrorResult(result)).toBe(false);
    const mcpBody = JSON.parse(mcpText(result)) as Record<string, unknown>;
    expect(mcpBody).toEqual(httpBody);
    expect(mcpBody).toMatchObject({ ok: true, kind: "follow-up", deduped: false });
    const queued = await mcpStore.get(mcpBody.jobId as number);
    expect(queued?.jobKey).toBe("follow-up:kirmanak/demo#7:abc123");
    expect(await mcpStore.readIssueSkipLatch("kirmanak", "demo", 12)).toMatchObject({ skipReason: null });
    expect(await mcpStore.sits.get("kirmanak", "demo", 12)).toBeUndefined();
    const kickLog = (await mcpStore.listKickLog(500)).filter((entry) => entry.number === 12);
    expect(kickLog).toHaveLength(1);
    expect(kickLog[0]).toMatchObject({ actor: "board-mcp", kick: "stuck", result: "ok" });
  });

  test("same idempotency_key twice replays the first outcome", async () => {
    const store = new MemoryReviewJobStore();
    const seed = await seedFailedReview(store, { reason: "boom" });
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const args = {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: seed.kick,
      commit: seed.commit,
      idempotency_key: "mcp-replay-1",
    };
    const first = await mcpCall(handler, KICK_TOKEN, "kick", args);
    expect(isErrorResult(first.result)).toBe(false);
    const firstBody = JSON.parse(mcpText(first.result)) as Record<string, unknown>;
    expect(firstBody.deduped).toBe(false);

    const second = await mcpCall(handler, KICK_TOKEN, "kick", args);
    expect(isErrorResult(second.result)).toBe(false);
    const secondBody = JSON.parse(mcpText(second.result)) as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      jobId: firstBody.jobId,
      newJobId: firstBody.jobId,
      terminalJobId: firstBody.terminalJobId,
      deduped: true,
    });
    // Still exactly one queued row: the replay inserted nothing.
    const queued = [...store.rows].filter((row) => row.state === "queued");
    expect(queued).toHaveLength(1);
  });

  test("peer-forge forge argument is refused and nothing is forwarded", async () => {
    const store = new MemoryReviewJobStore();
    await store.sits.remember("kirmanak", "demo", 7, "not-labeled");
    let forwarded = 0;
    const forgeApi: BoardPullForge = {
      getPR: async () => {
        forwarded += 1;
        return { state: "closed", merged: false, head: { sha: "deadbeef" } };
      },
      closePullRequest: async () => {
        forwarded += 1;
        return {};
      },
      reopenPullRequest: async () => {
        forwarded += 1;
        return {};
      },
    };
    const logs: string[] = [];
    const handler = makeHandler(store, logs, { forgeApi });
    const { result } = await mcpCall(handler, KICK_TOKEN, "kick", {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: "sit-clear",
      forge: "github",
    });
    expect(isErrorResult(result)).toBe(true);
    expect(mcpText(result)).toContain("peer forge");
    expect(forwarded).toBe(0);
    expect(await store.sits.get("kirmanak", "demo", 7)).toBeDefined();
    expect(await store.listKickLog(500)).toHaveLength(0);
  });

  test("a bot token planted in a why comes back redacted", async () => {
    const store = new MemoryReviewJobStore();
    await seedFailedReview(store, { reason: `${BOT_TOKEN} boom` });
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    // Wrong kick id: the stale-kick refusal echoes the stored reason.
    const { result } = await mcpCall(handler, KICK_TOKEN, "kick", {
      owner: "kirmanak",
      repo: "demo",
      number: 7,
      kick: "wrong-kick",
      commit: "abc123",
    });
    expect(isErrorResult(result)).toBe(true);
    const text = mcpText(result);
    expect(text).toContain("Kick id does not match");
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).toContain("***");
    const raw = JSON.stringify(text);
    expect(raw).not.toContain(BOT_TOKEN);
    for (const line of logs) {
      expect(line).not.toContain(BOT_TOKEN);
      expect(line).not.toContain(KICK_TOKEN);
    }
  });

  test("SDK client: initialize, list tools with each token, and call kick", async () => {
    const store = new MemoryReviewJobStore();
    await store.sits.remember("kirmanak", "demo", 7, "not-labeled");
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const readTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
      });
      const readClient = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
      await readClient.connect(readTransport);
      const readListed = await readClient.listTools();
      expect(readListed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "runners"]);
      await readClient.close();

      const kickTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${KICK_TOKEN}` } },
      });
      const kickClient = new Client({ name: "board-mcp-kick-test", version: "1.0.0" });
      await kickClient.connect(kickTransport);
      const kickListed = await kickClient.listTools();
      expect(kickListed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "kick", "runners"]);
      const kicked = await kickClient.callTool({
        name: "kick",
        arguments: { owner: "kirmanak", repo: "demo", number: 7, kick: "sit-clear" },
      });
      expect(isErrorResult(kicked)).toBe(false);
      expect(JSON.parse(mcpText(kicked))).toMatchObject({ ok: true, owner: "kirmanak", repo: "demo", number: 7 });
      await kickClient.close();
    } finally {
      server.stop(true);
    }
    expect(await store.sits.get("kirmanak", "demo", 7)).toBeUndefined();
    for (const line of logs) {
      expect(line).not.toContain(READ_TOKEN);
      expect(line).not.toContain(KICK_TOKEN);
    }
  });
});
