import { describe, expect, test } from "bun:test";
import { agyMcpServerEntry, claudeMcpConfigFor, codexMcpTomlEntry, openCodeMcpEntry } from "../src/review_mcp.ts";
import {
  agyWorkerMcpEntry,
  buildNoChangesSticky,
  claudeWorkerMcpConfig,
  codexWorkerMcpTomlEntry,
  countReasonSentences,
  MAX_WORKER_BLOCKED_REASON_CHARS,
  MAX_WORKER_NO_CHANGES_REASON_CHARS,
  MAX_WORKER_PR_BODY_CHARS,
  MAX_WORKER_PR_REMAINING_ITEM_CHARS,
  MAX_WORKER_PR_REMAINING_ITEMS,
  MAX_WORKER_SKIP_REASON_CHARS,
  openCodeWorkerMcpEntry,
  parseBlockedOnRef,
  preferWorkerTool,
  probeWorkerMcpInit,
  probeWorkerMcpServer,
  startWorkerMcpServer,
  validateBlockedOn,
  validateHandoffNotes,
  validateNoChangesReason,
  validatePrBody,
  validatePrRemaining,
  validateSkipReason,
  WORKER_HANDOFF_MAX_BYTES,
  WORKER_MCP_SERVER_NAME,
  WORKER_MCP_TOOL_NAMES,
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
    // Dots inside a URL must not count as sentence boundaries.
    expect(countReasonSentences("Blocked on https://gitea.example.com/org/repo/pulls/1. See the link.")).toBe(2);
    expect(
      validateNoChangesReason(
        "Review finding already addressed in abc123. Blocked on an external fix, see https://gitea.example.com/org/repo/pulls/1. Keeping the tree as is."
      ).ok
    ).toBe(true);
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

  test("link-bearing reason is accepted by the tool", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "no_changes", {
        reason:
          "Review finding already addressed in abc123. Blocked on an external fix, see https://gitea.example.com/org/repo/pulls/1. Keeping the tree as is.",
      });
      expect(out.ok).toBe(true);
      expect(store.getNoChangesReason()).toContain("https://gitea.example.com");
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

  test("tool list names all five worker tools", async () => {
    expect(new Set(WORKER_MCP_TOOL_NAMES)).toEqual(
      new Set(["blocked_on", "finding_response", "no_changes", "set_handoff", "set_pr_body", "skip"])
    );
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const payload = (await res.json()) as { result?: { tools?: Array<{ name?: string }> } };
      const names = (payload.result?.tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual(["blocked_on", "finding_response", "no_changes", "set_handoff", "set_pr_body", "skip"]);
    } finally {
      server.close();
    }
  });

  test("set_pr_body round-trips and validates", async () => {
    expect(validatePrBody(undefined).ok).toBe(false);
    expect(validatePrBody("   ").ok).toBe(false);
    expect(validatePrBody("What changed.\n\nFixes #12").ok).toBe(true);
    expect(validatePrBody("x".repeat(MAX_WORKER_PR_BODY_CHARS + 1)).ok).toBe(false);
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const bad = await probeWorkerMcpServer(server.url, "tok", "set_pr_body", { markdown: "" });
      expect(bad.ok).toBe(false);
      const out = await probeWorkerMcpServer(server.url, "tok", "set_pr_body", {
        markdown: "Did the thing.\n\nFixes #12",
      });
      expect(out.ok).toBe(true);
      expect(store.getPrBody()).toContain("Did the thing");
      expect(store.hasPrBody()).toBe(true);
      const second = await probeWorkerMcpServer(server.url, "tok", "set_pr_body", { markdown: "Second body." });
      expect(second.ok).toBe(true);
      expect(store.getPrBody()).toBe("Second body.");
    } finally {
      server.close();
    }
  });

  test("set_pr_body remaining list round-trips, validates, and aliases", async () => {
    expect(validatePrRemaining(undefined)).toEqual({ ok: true, remaining: undefined });
    expect(validatePrRemaining(null)).toEqual({ ok: true, remaining: undefined });
    expect(validatePrRemaining([])).toEqual({ ok: true, remaining: [] });
    expect(validatePrRemaining(["  ", "backfill x  "])).toEqual({ ok: true, remaining: ["backfill x"] });
    expect(validatePrRemaining("nope").ok).toBe(false);
    expect(validatePrRemaining([42]).ok).toBe(false);
    expect(validatePrRemaining(new Array(MAX_WORKER_PR_REMAINING_ITEMS + 1).fill("x")).ok).toBe(false);
    expect(validatePrRemaining(["x".repeat(MAX_WORKER_PR_REMAINING_ITEM_CHARS + 1)]).ok).toBe(false);
    const store = new WorkerResultStore();
    expect(store.setPrBody({ markdown: "Done.\n\nFixes #12", remaining: [] }).ok).toBe(true);
    expect(store.getPrRemaining()).toEqual([]);
    const aliased = new WorkerResultStore();
    expect(aliased.setPrBody({ markdown: "Part.", remaining_items: ["one more"] }).ok).toBe(true);
    expect(aliased.getPrRemaining()).toEqual(["one more"]);
    const camel = new WorkerResultStore();
    expect(camel.setPrBody({ markdown: "Part.", remainingItems: ["other"] }).ok).toBe(true);
    expect(camel.getPrRemaining()).toEqual(["other"]);
    const serverStore = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store: serverStore, token: "tok" });
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "set_pr_body", {
        markdown: "Part.\n\nRefs #12",
        remaining: ["one more case"],
      });
      expect(out.ok).toBe(true);
      expect(serverStore.getPrRemaining()).toEqual(["one more case"]);
      const cleared = await probeWorkerMcpServer(server.url, "tok", "set_pr_body", {
        markdown: "Done.\n\nFixes #12",
      });
      expect(cleared.ok).toBe(true);
      expect(serverStore.getPrRemaining()).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test("set_pr_body names the maintainer-written addendum case", async () => {
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const payload = (await res.json()) as {
        result?: { tools?: Array<{ name?: string; description?: string }> };
      };
      const tool = (payload.result?.tools ?? []).find((t) => t.name === "set_pr_body");
      expect(tool?.description).toContain("maintainer-written");
      expect(tool?.description).toContain("Jumi section appended below it");
    } finally {
      server.close();
    }
    const unfencedStore = new WorkerResultStore();
    const unfencedServer = await startWorkerMcpServer({ store: unfencedStore, token: "tok", prBodyFenced: false });
    try {
      const out = await probeWorkerMcpServer(unfencedServer.url, "tok", "set_pr_body", {
        markdown: "Disclosure.\n\nFixes #12",
      });
      expect(out.ok).toBe(true);
      expect(out.text).toContain("addendum");
      expect(out.text).toContain("maintainer-written");
    } finally {
      unfencedServer.close();
    }
    const fencedStore = new WorkerResultStore();
    const fencedServer = await startWorkerMcpServer({ store: fencedStore, token: "tok", prBodyFenced: true });
    try {
      const out = await probeWorkerMcpServer(fencedServer.url, "tok", "set_pr_body", {
        markdown: "Disclosure.\n\nFixes #12",
      });
      expect(out.ok).toBe(true);
      expect(out.text).not.toContain("addendum");
    } finally {
      fencedServer.close();
    }
  });

  test("skip round-trips and validates", async () => {
    expect(validateSkipReason(undefined).ok).toBe(false);
    expect(validateSkipReason("").ok).toBe(false);
    expect(validateSkipReason("Nothing to change here.").ok).toBe(true);
    expect(validateSkipReason("x".repeat(MAX_WORKER_SKIP_REASON_CHARS + 1)).ok).toBe(false);
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "skip", { reason: "Already fixed on main." });
      expect(out.ok).toBe(true);
      expect(store.getSkipReason()).toBe("Already fixed on main.");
    } finally {
      server.close();
    }
  });

  test("blocked_on round-trips and validates refs", async () => {
    expect(parseBlockedOnRef("#12", "o", "r").ok).toBe(true);
    expect(parseBlockedOnRef("o/r#12").ok).toBe(true);
    expect(parseBlockedOnRef("bogus").ok).toBe(false);
    expect(validateBlockedOn({ ref: "#12" }).ok).toBe(false);
    expect(validateBlockedOn({ ref: "#12", reason: "waiting" }).ok).toBe(true);
    expect(validateBlockedOn({ ref: "o/r#12", reason: "x".repeat(MAX_WORKER_BLOCKED_REASON_CHARS + 1) }).ok).toBe(
      false
    );
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const bad = await probeWorkerMcpServer(server.url, "tok", "blocked_on", { ref: "nope", reason: "waiting" });
      expect(bad.ok).toBe(false);
      expect(store.hasBlockedOn()).toBe(false);
      const out = await probeWorkerMcpServer(server.url, "tok", "blocked_on", {
        ref: "other/repo#34",
        reason: "Need that fix first.",
      });
      expect(out.ok).toBe(true);
      expect(store.getBlockedOn()).toMatchObject({ ref: "other/repo#34", number: 34, reason: "Need that fix first." });
      const local = await probeWorkerMcpServer(server.url, "tok", "blocked_on", { ref: "#12", reason: "Second." });
      expect(local.ok).toBe(true);
      expect(store.getBlockedOn()?.ref).toBe("#12");
    } finally {
      server.close();
    }
  });

  test("set_handoff round-trips, caps at 16 KiB, and closes with the spawn", async () => {
    expect(WORKER_HANDOFF_MAX_BYTES).toBe(16 * 1024);
    expect(validateHandoffNotes(undefined).ok).toBe(false);
    expect(validateHandoffNotes("   ").ok).toBe(false);
    expect(validateHandoffNotes("key files: src/a.ts").ok).toBe(true);
    expect(validateHandoffNotes("x".repeat(WORKER_HANDOFF_MAX_BYTES + 1)).ok).toBe(false);
    const store = new WorkerResultStore();
    const server = await startWorkerMcpServer({ store, token: "tok" });
    try {
      const out = await probeWorkerMcpServer(server.url, "tok", "set_handoff", { notes: "key files: src/a.ts" });
      expect(out.ok).toBe(true);
      expect(store.getHandoff()).toContain("src/a.ts");
      expect(store.hasHandoff()).toBe(true);
    } finally {
      server.close();
    }
    const closed = new WorkerResultStore();
    const closedServer = await startWorkerMcpServer({ store: closed, token: "tok" });
    closed.close();
    try {
      for (const tool of ["no_changes", "set_pr_body", "skip", "blocked_on", "set_handoff"] as const) {
        const out = await probeWorkerMcpServer(closedServer.url, "tok", tool, {
          reason: "one sentence.",
          markdown: "body",
          ref: "#1",
          notes: "notes",
        });
        expect(out.ok).toBe(false);
        expect(out.text).toMatch(/spawn ended/);
      }
    } finally {
      closedServer.close();
    }
  });

  test("preferWorkerTool prefers the tool and logs the path", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    expect(preferWorkerTool("pr_body", "tool body", "file body", log)).toEqual({
      value: "tool body",
      source: "tool",
    });
    expect(logs.at(-1)).toContain("from tool");
    expect(preferWorkerTool("pr_body", null, "file body", log)).toEqual({
      value: "file body",
      source: "file fallback",
    });
    expect(logs.at(-1)).toContain("file fallback");
    expect(preferWorkerTool("pr_body", null, null, log)).toEqual({ value: null, source: "missing" });
    expect(logs.at(-1)).toContain("missing");
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
