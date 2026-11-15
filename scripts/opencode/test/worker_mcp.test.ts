import { describe, expect, test } from "bun:test";
import { agyMcpServerEntry, claudeMcpConfigFor, codexMcpTomlEntry, openCodeMcpEntry } from "../src/review_mcp.ts";
import {
  agyWorkerMcpEntry,
  buildNoChangesSticky,
  claudeWorkerMcpConfig,
  codexWorkerMcpTomlEntry,
  countReasonSentences,
  MAX_WORKER_NO_CHANGES_REASON_CHARS,
  openCodeWorkerMcpEntry,
  probeWorkerMcpInit,
  probeWorkerMcpServer,
  startWorkerMcpServer,
  validateNoChangesReason,
  WORKER_MCP_SERVER_NAME,
  WorkerResultStore,
} from "../src/worker_mcp.ts";

const TRICKY_TOKEN = 'tok"en\\with-quotes';
const URL = "http://127.0.0.1:9/mcp";

describe("worker MCP server", () => {
  test("initialize + no_changes round-trip reaches the parent store", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      expect(await probeWorkerMcpInit(server.url, "tok")).toBe(true);
      const out = await probeWorkerMcpServer(server.url, "tok", "no_changes", {
        reason: "CI failed on a flake. Evidence shows it passed on retry.",
      });
      expect(out.ok).toBe(true);
      expect(store.getNoChangesReason()).toContain("flake");
    } finally {
      server.close();
    }
  });

  test("wrong or missing token is rejected", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "right" });
    try {
      const wrong = await probeWorkerMcpServer(server.url, "wrong", "no_changes", { reason: "one sentence." });
      expect(wrong.ok).toBe(false);
      expect(store.hasNoChanges()).toBe(false);
    } finally {
      server.close();
    }
  });

  test("reason validation: required, 1-3 sentences, length-capped", async () => {
    expect(validateNoChangesReason(undefined).ok).toBe(false);
    expect(validateNoChangesReason("").ok).toBe(false);
    expect(validateNoChangesReason("   ").ok).toBe(false);
    expect(validateNoChangesReason("Already addressed in abc123.").ok).toBe(true);
    expect(countReasonSentences("a. b. c. d.")).toBe(4);
    expect(validateNoChangesReason("a. b. c. d.").ok).toBe(false);
    expect(validateNoChangesReason("a. b. c.").ok).toBe(true);
    const long = `${"x".repeat(MAX_WORKER_NO_CHANGES_REASON_CHARS + 1)}.`;
    expect(validateNoChangesReason(long).ok).toBe(false);
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const bad = await probeWorkerMcpServer(server.url, "tok", "no_changes", { reason: "" });
      expect(bad.ok).toBe(false);
      expect(bad.text).toMatch(/reason is required/);
      const many = await probeWorkerMcpServer(server.url, "tok", "no_changes", { reason: "a. b. c. d." });
      expect(many.ok).toBe(false);
      expect(store.hasNoChanges()).toBe(false);
    } finally {
      server.close();
    }
  });

  test("calls after the spawn ended are rejected", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    store.close();
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "no_changes", { reason: "one sentence." });
      expect(out.ok).toBe(false);
      expect(out.text).toMatch(/spawn ended/);
    } finally {
      server.close();
    }
  });

  test("unknown tool is an error", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "bogus", {});
      expect(out.ok).toBe(false);
    } finally {
      server.close();
    }
  });

  test("last no_changes call wins", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      expect((await probeWorkerMcpServer(server.url, "tok", "no_changes", { reason: "First reason." })).ok).toBe(true);
      expect((await probeWorkerMcpServer(server.url, "tok", "no_changes", { reason: "Second reason." })).ok).toBe(true);
      expect(store.getNoChangesReason()).toBe("Second reason.");
    } finally {
      server.close();
    }
  });
});

describe("worker MCP sticky", () => {
  test("clean reason posts with sanitised separator", () => {
    expect(buildNoChangesSticky("CI flake, evidence in the log.")).toBe(
      "no follow-up changes: CI flake, evidence in the log."
    );
  });

  test("fail-open fallback when the model never calls the tool", () => {
    expect(buildNoChangesSticky(undefined)).toBe("no follow-up changes (no reason given)");
    expect(buildNoChangesSticky("")).toBe("no follow-up changes (no reason given)");
    expect(buildNoChangesSticky("   ")).toBe("no follow-up changes (no reason given)");
  });

  test("reason rides the verdict sanitiser (no > or --> survives)", () => {
    const sticky = buildNoChangesSticky("blocked on external fix -> see a > b.");
    expect(sticky).toContain("no follow-up changes:");
    expect(sticky).not.toContain(">");
    expect(sticky).not.toContain("-->");
  });
});

describe("worker MCP per-runner configs", () => {
  test("server name stays separate from jumi-review", () => {
    expect(WORKER_MCP_SERVER_NAME).toBe("jumi-worker");
    expect(WORKER_MCP_SERVER_NAME).not.toBe("jumi-review");
  });

  test("opencode entry round-trips through JSON with a tricky token", () => {
    const entry = openCodeWorkerMcpEntry(URL, TRICKY_TOKEN) as {
      url: string;
      headers: Record<string, string>;
    };
    const parsed = JSON.parse(JSON.stringify(entry)) as typeof entry;
    expect(parsed.url).toBe(URL);
    expect(parsed.headers.Authorization).toBe(`Bearer ${TRICKY_TOKEN}`);
    // Shared shape with the review entry: no per-runner copy.
    expect(entry as unknown).toEqual(openCodeMcpEntry(URL, TRICKY_TOKEN));
  });

  test("claude config round-trips through JSON with a tricky token", () => {
    const raw = claudeWorkerMcpConfig(URL, TRICKY_TOKEN);
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(parsed.mcpServers[WORKER_MCP_SERVER_NAME]?.url).toBe(URL);
    expect(parsed.mcpServers[WORKER_MCP_SERVER_NAME]?.headers?.Authorization).toBe(`Bearer ${TRICKY_TOKEN}`);
    expect(parsed.mcpServers["jumi-review"]).toBeUndefined();
    // Shared builder with the review config.
    expect(raw).toBe(claudeMcpConfigFor(WORKER_MCP_SERVER_NAME, URL, TRICKY_TOKEN));
  });

  test("codex TOML round-trips through Bun.TOML.parse with a tricky token", () => {
    const entry = codexWorkerMcpTomlEntry(URL, TRICKY_TOKEN);
    const parsed = Bun.TOML.parse(entry) as {
      mcp_servers?: Record<string, { url?: unknown; http_headers?: Record<string, unknown> }>;
    };
    expect(parsed.mcp_servers?.[WORKER_MCP_SERVER_NAME]?.url).toBe(URL);
    expect(parsed.mcp_servers?.[WORKER_MCP_SERVER_NAME]?.http_headers?.Authorization).toBe(`Bearer ${TRICKY_TOKEN}`);
    expect(parsed.mcp_servers?.["jumi-review"]).toBeUndefined();
    // Shared builder with the review entry.
    expect(entry).toBe(codexMcpTomlEntry(WORKER_MCP_SERVER_NAME, URL, TRICKY_TOKEN));
  });

  test("agy entry round-trips through JSON with a tricky token", () => {
    const entry = agyWorkerMcpEntry(URL, TRICKY_TOKEN) as {
      serverUrl: string;
      headers: Record<string, string>;
    };
    const file = JSON.stringify({ mcpServers: { [WORKER_MCP_SERVER_NAME]: entry } });
    const parsed = JSON.parse(file) as {
      mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string> }>;
    };
    expect(parsed.mcpServers[WORKER_MCP_SERVER_NAME]?.serverUrl).toBe(URL);
    expect(parsed.mcpServers[WORKER_MCP_SERVER_NAME]?.headers?.Authorization).toBe(`Bearer ${TRICKY_TOKEN}`);
    expect(parsed.mcpServers["jumi-review"]).toBeUndefined();
    // Shared shape with the review entry.
    expect(entry as unknown).toEqual(agyMcpServerEntry(URL, TRICKY_TOKEN));
  });
});
