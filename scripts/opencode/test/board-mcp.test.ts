import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBoardFetchHandler } from "../src/board.ts";
import { BOARD_MCP_TEXT_MAX_BYTES, BOARD_MCP_TOKEN_ENV, BOARD_MCP_TRUNCATION_MARKER } from "../src/board_mcp.ts";
import { reviewJobKey } from "../src/review.ts";
import { MemoryReviewJobStore, workerJobKey } from "../src/review_jobs.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

const MCP_TOKEN = "mcp-secret-token";
const PEER_TOKEN = "peer-secret-token";
const BOT_TOKEN = "planted-bot-token-xyz";

function makeHandler(
  store: MemoryReviewJobStore,
  logs: string[],
  opts: { mcpToken?: string; peerToken?: string; forge?: string } = {}
): (request: Request) => Promise<Response> {
  return createBoardFetchHandler({
    store,
    getGrantNotice: () => undefined,
    logger: (message: string) => {
      logs.push(message);
    },
    forge: opts.forge,
    ...(opts.mcpToken !== undefined ? { mcpToken: opts.mcpToken } : { mcpToken: MCP_TOKEN }),
    ...(opts.peerToken !== undefined ? { peerToken: opts.peerToken } : {}),
    mcpSecrets: [BOT_TOKEN, "webhook-secret", PEER_TOKEN, MCP_TOKEN],
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
const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

async function seedReviewRow(
  store: MemoryReviewJobStore,
  opts: { prNumber: number; headSha: string; state: "succeeded" | "failed" | "cancelled"; reason?: string }
): Promise<number> {
  const job = makeJob({
    delivery: `d-${opts.prNumber}-${opts.headSha}`,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
  });
  await store.enqueue(job);
  if (opts.state === "cancelled") {
    await store.drop(reviewJobKey(job));
    const row = [...store.rows].reverse().find((item) => item.jobKey === reviewJobKey(job));
    if (!row) throw new Error("expected a cancelled row");
    return row.id;
  }
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a review lease");
  if (opts.state === "failed") {
    await store.saveResult(leased.id, "worker", { kind: "error", error: opts.reason ?? "boom" });
  } else {
    await store.saveResult(leased.id, "worker", { kind: "markdown", markdown: "done" });
  }
  await store.markPublished(leased.id, "worker", { state: opts.state, reason: opts.reason });
  return leased.id;
}

async function seedFollowupRow(
  store: MemoryReviewJobStore,
  opts: {
    issueNumber: number;
    prNumber: number;
    headSha: string;
    state: "succeeded" | "failed" | "cancelled";
    reason?: string;
  }
): Promise<number> {
  const job = makeIssueJob({
    delivery: `d-f-${opts.issueNumber}-${opts.headSha}`,
    mode: "follow-up",
    prNumber: opts.prNumber,
    headSha: opts.headSha,
  });
  await store.enqueueIssue({ ...job, issueNumber: opts.issueNumber });
  if (opts.state === "cancelled") {
    await store.drop(workerJobKey({ ...job, issueNumber: opts.issueNumber }));
    const row = [...store.rows].reverse().find((item) => item.headSha === opts.headSha);
    if (!row) throw new Error("expected a cancelled row");
    return row.id;
  }
  const leased = await store.lease("worker", 60_000, new Date(), ["follow-up"]);
  if (!leased) throw new Error("expected a follow-up lease");
  if (opts.state === "failed") {
    await store.saveResult(leased.id, "worker", { kind: "error", error: opts.reason ?? "follow-up boom" });
  } else {
    await store.saveResult(leased.id, "worker", { kind: "markdown", markdown: "follow-up done" });
  }
  await store.markPublished(leased.id, "worker", { state: opts.state, reason: opts.reason });
  return leased.id;
}

function mcpText(result: unknown): string {
  const rec = result as { content?: Array<{ type?: string; text?: string }> };
  const first = rec.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("expected text content");
  return first.text;
}

describe("board read-only MCP (#644)", () => {
  test("token env constant stays in sync with the loader literal", () => {
    expect(BOARD_MCP_TOKEN_ENV).toBe("BOARD_MCP_TOKEN");
  });

  test("unset token: /mcp 404, /api/board unchanged", async () => {
    const store = new MemoryReviewJobStore();
    // Truly tokenless handler: unset and blank both disable /mcp.
    const bare = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const missing = await bare(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, bearer(MCP_TOKEN))
    );
    expect(missing.status).toBe(404);
    const empty = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      mcpToken: "   ",
    });
    expect((await empty(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(MCP_TOKEN)))).status).toBe(
      404
    );

    const board = await bare(
      new Request("https://board.test/api/board", { method: "GET", headers: new Headers(EDGE_HEADERS) })
    );
    expect(board.status).toBe(200);
  });

  test("missing or wrong bearer: 401; other methods: 405", async () => {
    const store = new MemoryReviewJobStore();
    const handler = makeHandler(store, []);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await handler(mcpRequest(init))).status).toBe(401);
    expect((await handler(mcpRequest(init, bearer("wrong")))).status).toBe(401);
    expect((await handler(mcpRequest(init, {}, "GET"))).status).toBe(405);
    expect((await handler(mcpRequest(init, bearer(MCP_TOKEN), "PUT"))).status).toBe(405);
  });

  test("edge identity alone is 401 and the peer token never authenticates /mcp", async () => {
    const store = new MemoryReviewJobStore();
    const handler = makeHandler(store, [], { peerToken: PEER_TOKEN });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await handler(mcpRequest(init, EDGE_HEADERS))).status).toBe(401);
    expect((await handler(mcpRequest(init, { ...EDGE_HEADERS, ...bearer(PEER_TOKEN) }))).status).toBe(401);
    expect((await handler(mcpRequest(init, bearer(PEER_TOKEN)))).status).toBe(401);
  });

  test("same behaviour on the github forge", async () => {
    const store = new MemoryReviewJobStore();
    const handler = makeHandler(store, [], { forge: "github", peerToken: PEER_TOKEN });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await handler(mcpRequest(init))).status).toBe(401);
    // The peer bearer still serves the peer board JSON, never /mcp.
    const board = await handler(
      new Request("https://board.test/api/board", { method: "GET", headers: new Headers(bearer(PEER_TOKEN)) })
    );
    expect(board.status).toBe(200);
    const bareGithub = createBoardFetchHandler({
      store,
      getGrantNotice: () => undefined,
      logger: () => {},
      forge: "github",
      peerToken: PEER_TOKEN,
    });
    expect((await bareGithub(mcpRequest(init, bearer(MCP_TOKEN)))).status).toBe(404);
  });

  test("SDK client: initialize, tools/list returns exactly the three tools, call each tool", async () => {
    const store = new MemoryReviewJobStore();
    await seedReviewRow(store, { prNumber: 7, headSha: "abc123", state: "failed", reason: "boom" });
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["board", "issue_history", "runners"]);

      const board = await client.callTool({ name: "board", arguments: {} });
      expect(board.isError).toBeFalsy();
      const groups = JSON.parse(mcpText(board)) as {
        in_progress: unknown[];
        needs_kick: unknown[];
        sitting: unknown[];
      };
      // The failed terminal row is not in progress; it is offered as a requeue kick.
      expect(groups.in_progress).toHaveLength(0);
      expect(groups.needs_kick).toHaveLength(1);

      const history = await client.callTool({
        name: "issue_history",
        arguments: { owner: "kirmanak", repo: "demo", number: 7 },
      });
      expect(history.isError).toBeFalsy();
      const parsed = JSON.parse(mcpText(history)) as { rows: Array<{ state: string }> };
      expect(parsed.rows.map((row) => row.state)).toEqual(["failed"]);

      const runners = await client.callTool({ name: "runners", arguments: {} });
      expect(runners.isError).toBeFalsy();
      const runnerPayload = JSON.parse(mcpText(runners)) as { cooldowns: unknown[]; quotaResets: unknown[] };
      expect(runnerPayload.cooldowns).toEqual([]);
      expect(runnerPayload.quotaResets).toEqual([]);
      await client.close();
    } finally {
      server.stop(true);
    }
    expect(logs.filter((line) => line.startsWith("[board-mcp] tool="))).toHaveLength(3);
    for (const line of logs) {
      expect(line).not.toContain(MCP_TOKEN);
    }
  });

  test("issue_history returns succeeded, failed and cancelled rows, newest first, for issue and pull numbers", async () => {
    const store = new MemoryReviewJobStore();
    // Worker rows share the issue number across terminals; review rows share the pull number.
    const succeeded = await seedFollowupRow(store, {
      issueNumber: 12,
      prNumber: 70,
      headSha: "f-one",
      state: "succeeded",
    });
    const failed = await seedFollowupRow(store, {
      issueNumber: 12,
      prNumber: 70,
      headSha: "f-two",
      state: "failed",
      reason: "follow-up boom",
    });
    const cancelled = await seedFollowupRow(store, {
      issueNumber: 12,
      prNumber: 70,
      headSha: "f-three",
      state: "cancelled",
    });
    const reviewOk = await seedReviewRow(store, { prNumber: 7, headSha: "sha-one", state: "succeeded" });
    const reviewFailed = await seedReviewRow(store, { prNumber: 7, headSha: "sha-two", state: "failed" });
    const reviewCancelled = await seedReviewRow(store, { prNumber: 7, headSha: "sha-three", state: "cancelled" });

    const logs: string[] = [];
    const handler = makeHandler(store, logs);

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);

      const byIssue = JSON.parse(
        mcpText(
          await client.callTool({ name: "issue_history", arguments: { owner: "kirmanak", repo: "demo", number: 12 } })
        )
      ) as {
        owner: string;
        repo: string;
        number: number;
        rows: Array<Record<string, unknown>>;
        skipLatch: unknown;
        sit: unknown;
        kickLog: unknown[];
      };
      expect(byIssue.owner).toBe("kirmanak");
      expect(byIssue.number).toBe(12);
      expect(byIssue.rows.map((row) => row.id)).toEqual([cancelled, failed, succeeded]);
      expect(byIssue.rows.map((row) => row.state).sort()).toEqual(["cancelled", "failed", "succeeded"]);
      expect(byIssue.rows.every((row) => row.issueNumber === 12)).toBe(true);
      for (const row of byIssue.rows) {
        expect(Object.keys(row).sort()).toEqual(
          [
            "attempt",
            "cancelRequested",
            "createdAt",
            "error",
            "headSha",
            "id",
            "issueNumber",
            "kind",
            "leasedBy",
            "prNumber",
            "resultReason",
            "resultRunner",
            "state",
            "updatedAt",
          ].sort()
        );
        expect(row).not.toHaveProperty("payload");
        expect(row).not.toHaveProperty("resultMarkdown");
      }

      const byPull = JSON.parse(
        mcpText(
          await client.callTool({ name: "issue_history", arguments: { owner: "kirmanak", repo: "demo", number: 7 } })
        )
      ) as { rows: Array<Record<string, unknown>> };
      expect(byPull.rows.map((row) => row.id)).toEqual([reviewCancelled, reviewFailed, reviewOk]);
      expect(byPull.rows.map((row) => row.state).sort()).toEqual(["cancelled", "failed", "succeeded"]);
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("issue_history caps at 50 rows and surfaces latch, sit, and kick-log entries", async () => {
    const store = new MemoryReviewJobStore();
    for (let index = 0; index < 55; index++) {
      await seedFollowupRow(store, {
        issueNumber: 99,
        prNumber: 71,
        headSha: `cap-sha-${index}`,
        state: "cancelled",
      });
    }
    await store.setIssueSkipReason("kirmanak", "demo", 99, "stuck: too many follow-up rounds");
    await store.sits.remember("kirmanak", "demo", 99, "not-labeled");
    // Terminal-only numbers accept kick-log rows without a job insert.
    await store.recordReopenKick({
      owner: "kirmanak",
      repo: "demo",
      number: 99,
      commit: "sha9",
      kick: "reopen",
      actor: "operator",
      idempotencyKey: "mcp-kick-99",
      result: "noop-open",
    });

    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      const payload = JSON.parse(
        mcpText(
          await client.callTool({ name: "issue_history", arguments: { owner: "kirmanak", repo: "demo", number: 99 } })
        )
      ) as {
        rows: Array<{ id: number }>;
        skipLatch: { skipReason: string | null };
        sit: { reason: string } | null;
        kickLog: Array<{ kick: string; result: string }>;
      };
      expect(payload.rows).toHaveLength(50);
      const ids = payload.rows.map((row) => row.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
      expect(payload.skipLatch.skipReason).toBe("stuck: too many follow-up rounds");
      expect(payload.sit?.reason).toBe("not-labeled");
      expect(payload.kickLog).toHaveLength(1);
      expect(payload.kickLog[0]).toMatchObject({ kick: "reopen", result: "noop-open" });
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("error is truncated at 2 KiB and a planted bot token comes back redacted", async () => {
    const store = new MemoryReviewJobStore();
    // The token sits inside the kept head so truncation alone cannot hide the redaction check.
    const longError = `${BOT_TOKEN} ${"x".repeat(5000)}`;
    await seedReviewRow(store, { prNumber: 8, headSha: "long-sha", state: "failed", reason: longError });
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      const payload = JSON.parse(
        mcpText(
          await client.callTool({ name: "issue_history", arguments: { owner: "kirmanak", repo: "demo", number: 8 } })
        )
      ) as { rows: Array<{ error: string }> };
      expect(payload.rows).toHaveLength(1);
      const error = payload.rows[0]?.error ?? "";
      expect(error).toContain(BOARD_MCP_TRUNCATION_MARKER);
      expect(new TextEncoder().encode(error).byteLength).toBeLessThanOrEqual(
        BOARD_MCP_TEXT_MAX_BYTES + new TextEncoder().encode(`\n${BOARD_MCP_TRUNCATION_MARKER}`).byteLength
      );
      expect(error.startsWith("***")).toBe(true);
      const raw = JSON.stringify(payload);
      expect(raw).not.toContain(BOT_TOKEN);
      expect(raw).toContain("***");
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("board with an owner/repo filter returns only that repo", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-home", prNumber: 7, headSha: "abc123" }));
    await store.enqueue(
      makeJob({ delivery: "d-other", owner: "other", repo: "other-repo", prNumber: 9, headSha: "def456" })
    );
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      const all = JSON.parse(mcpText(await client.callTool({ name: "board", arguments: {} }))) as {
        in_progress: Array<{ owner: string; repo: string }>;
      };
      expect(all.in_progress).toHaveLength(2);
      const filtered = JSON.parse(
        mcpText(await client.callTool({ name: "board", arguments: { owner: "other", repo: "other-repo" } }))
      ) as { in_progress: Array<{ owner: string; repo: string }>; needs_kick: unknown[]; sitting: unknown[] };
      expect(filtered.in_progress).toHaveLength(1);
      expect(filtered.in_progress[0]).toMatchObject({ owner: "other", repo: "other-repo" });
      expect(filtered.needs_kick).toEqual([]);
      expect(filtered.sitting).toEqual([]);
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("runners reports cooldowns and quota resets", async () => {
    const store = new MemoryReviewJobStore();
    await store.recordRunnerCooldown?.("engine", "opencode", Date.now() + 60_000, "quota", "provider", "fp-1");
    await store.recordRunnerCooldown?.("worker", "claude", Date.now() + 30_000, "auth", null, null);
    await store.recordRunUsageRows([
      {
        jobId: null,
        jobKey: "review:o/r#1:s",
        kind: "review",
        runner: "opencode",
        model: "openai/gpt-5.5",
        agentInstance: "jumi",
        tokensInput: 10,
        tokensCacheRead: 0,
        tokensOutput: 5,
        tokensCacheWrite: 0,
        tokensReasoning: 0,
        sessions: 1,
        exitClass: "ok",
        runnerOutcome: "ok",
        quotaResetAt: new Date(Date.now() + 3_600_000),
        startedAt: new Date(),
        endedAt: new Date(),
        durationSeconds: 1,
      },
    ]);
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      const payload = JSON.parse(mcpText(await client.callTool({ name: "runners", arguments: {} }))) as {
        cooldowns: Array<{ role: string; runner: string; reason: string | null }>;
        quotaResets: Array<{ runner: string; resetAtSeconds: number }>;
      };
      expect(payload.cooldowns.map((row) => `${row.role}:${row.runner}`).sort()).toEqual([
        "engine:opencode",
        "worker:claude",
      ]);
      expect(payload.cooldowns.find((row) => row.runner === "opencode")?.reason).toBe("quota");
      expect(payload.quotaResets).toHaveLength(1);
      expect(payload.quotaResets[0]?.runner).toBe("opencode");
      expect(typeof payload.quotaResets[0]?.resetAtSeconds).toBe("number");
      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("one log line per call, never the bearer or other arguments", async () => {
    const store = new MemoryReviewJobStore();
    await seedReviewRow(store, { prNumber: 7, headSha: "abc123", state: "failed", reason: "boom" });
    const logs: string[] = [];
    const handler = makeHandler(store, logs);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      const client = new Client({ name: "board-mcp-test", version: "1.0.0" });
      await client.connect(transport);
      await client.callTool({ name: "issue_history", arguments: { owner: "kirmanak", repo: "demo", number: 7 } });
      await client.close();
    } finally {
      server.stop(true);
    }
    const lines = logs.filter((line) => line.startsWith("[board-mcp] tool=issue_history"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[board-mcp\] tool=issue_history kirmanak\/demo#7 rows=1 ms=\d+$/);
  });
});
