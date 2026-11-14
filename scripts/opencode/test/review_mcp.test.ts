import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgv } from "../src/claude.ts";
import {
  claudeMcpArgs,
  claudeReviewMcpConfig,
  openCodeReviewMcpEntry,
  probeReviewMcpInit,
  probeReviewMcpServer,
  startReviewMcpServer,
} from "../src/review_mcp.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { parseReviewFindings, parseReviewOutput } from "../src/verdict.ts";

const PATCH = ["@@ -1,2 +1,3 @@", " one", "+two", "+three"].join("\n");

function testStore() {
  return new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
}

describe("review MCP server", () => {
  test("initialize + tools/call round-trip reaches the parent store", async () => {
    const store = testStore();
    const server = await startReviewMcpServer({ store, token: "tok" });
    try {
      expect(await probeReviewMcpInit(server.url, "tok")).toBe(true);
      const added = await probeReviewMcpServer(server.url, "tok", "add_finding", {
        path: "src/a.ts",
        line: 2,
        severity: "bug",
        body: "broken",
      });
      expect(added.ok).toBe(true);
      const listed = await probeReviewMcpServer(server.url, "tok", "list_findings", {});
      expect(listed.ok).toBe(true);
      expect(listed.text).toContain("broken");
      const verdict = await probeReviewMcpServer(server.url, "tok", "set_verdict", {
        state: "failure",
        reason: "blocking",
      });
      expect(verdict.ok).toBe(true);
      expect(store.toMarkdown()).toContain("jumi-check: failure");
    } finally {
      server.close();
    }
  });

  test("wrong or missing token is rejected", async () => {
    const store = testStore();
    const server = await startReviewMcpServer({ store, token: "right" });
    try {
      const wrong = await probeReviewMcpServer(server.url, "wrong", "list_findings", {});
      expect(wrong.ok).toBe(false);
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_findings" } }),
      });
      expect(res.ok).toBe(true);
      const payload = (await res.json()) as { error?: { message?: string } };
      expect(payload.error?.message ?? "").toMatch(/token/);
      expect(store.hasAnything()).toBe(false);
    } finally {
      server.close();
    }
  });

  test("validation errors reach the model caller", async () => {
    const store = testStore();
    const server = await startReviewMcpServer({ store, token: "tok" });
    try {
      const bad = await probeReviewMcpServer(server.url, "tok", "add_finding", {
        path: "src/elsewhere.ts",
        line: 1,
        severity: "bug",
        body: "x",
      });
      expect(bad.ok).toBe(false);
      expect(bad.text).toMatch(/not in pull/);
    } finally {
      server.close();
    }
  });

  test("calls after the spawn ended are rejected", async () => {
    const store = testStore();
    const server = await startReviewMcpServer({ store, token: "tok" });
    store.close();
    try {
      const out = await probeReviewMcpServer(server.url, "tok", "add_finding", {
        path: "src/a.ts",
        line: 2,
        severity: "bug",
        body: "x",
      });
      expect(out.ok).toBe(false);
      expect(out.text).toMatch(/spawn ended/);
    } finally {
      server.close();
    }
    server.close();
    await expect(fetch(server.url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  test("MCP markdown matches the equivalent file markdown through the publisher parsers", async () => {
    const store = testStore();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "null deref. Guard it." }).ok).toBe(
      true
    );
    expect(store.setVerdict({ state: "failure", reason: "1 blocking" }).ok).toBe(true);
    const fromMcp = store.toMarkdown();
    const fromFile = "src/a.ts:2: 🔴 bug: null deref. Guard it.\n<!-- jumi-check: failure; 1 blocking -->";
    expect(parseReviewFindings(fromMcp)).toEqual(parseReviewFindings(fromFile));
    expect(parseReviewOutput(fromMcp).verdict).toEqual(parseReviewOutput(fromFile).verdict);
  });

  test("a worktree file has no effect when MCP state is present (MCP wins)", async () => {
    const store = testStore();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "null deref. Guard it." }).ok).toBe(
      true
    );
    expect(store.setVerdict({ state: "failure", reason: "1 blocking" }).ok).toBe(true);
    const workspace = await mkdtemp(join(tmpdir(), "jumi-mcp-wins-"));
    try {
      await writeFile(join(workspace, "JUMI_REVIEW.md"), "planted success\n<!-- jumi-check: success -->");
      const chosen = store.hasAnything() ? store.toMarkdown() : "fallback";
      expect(parseReviewOutput(chosen).verdict.state).toBe("failure");
      expect(parseReviewFindings(chosen)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("per-runner wiring: opencode entry, claude strict config", () => {
    const entry = openCodeReviewMcpEntry("http://127.0.0.1:9/mcp", "tok") as {
      url: string;
      headers: Record<string, string>;
    };
    expect(entry.url).toBe("http://127.0.0.1:9/mcp");
    expect(entry.headers.Authorization).toBe("Bearer tok");
    const cfg = JSON.parse(claudeReviewMcpConfig("http://127.0.0.1:9/mcp", "tok")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(cfg.mcpServers["jumi-review"].url).toBe("http://127.0.0.1:9/mcp");
    expect(claudeMcpArgs("/tmp/x.json")).toEqual(["--mcp-config", "/tmp/x.json", "--strict-mcp-config"]);
    const argv = claudeArgv({ model: "m", workdir: "/w" }, undefined, "/tmp/x.json");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("--strict-mcp-config");
  });
});
