import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSearxngArgs,
  formatSearxngResult,
  isForgeSearchResult,
  normalizeMaxResults,
  openCodeSearxngServer,
  parseSearxngUrl,
  querySearxng,
  SEARXNG_CLAUDE_TOOL,
  SEARXNG_DEFAULT_RESULTS,
  SEARXNG_MAX_RESULTS,
  SEARXNG_OPENCODE_TOOL,
  SEARXNG_SERVER_FORGE_HOST_ENV,
  SEARXNG_SERVER_NAME,
  SEARXNG_SERVER_URL_ENV,
  SEARXNG_TIMEOUT_MS,
  SEARXNG_TOOL_NAME,
  SearxngError,
  searxngServerPath,
  searxngUrlFromEnv,
  webCapabilitiesForRunner,
  webEvidenceGuidance,
} from "../src/searxng.ts";

const ORIGINAL_URL = process.env.JUMI_SEARXNG_URL;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.JUMI_SEARXNG_URL;
  else process.env.JUMI_SEARXNG_URL = ORIGINAL_URL;
});

describe("parseSearxngUrl", () => {
  test("blank means not configured", () => {
    expect(parseSearxngUrl(undefined)).toBeUndefined();
    expect(parseSearxngUrl("")).toBeUndefined();
    expect(parseSearxngUrl("   ")).toBeUndefined();
    expect(searxngUrlFromEnv({})).toBeUndefined();
    expect(searxngUrlFromEnv({ JUMI_SEARXNG_URL: "" })).toBeUndefined();
  });

  test("accepts http and https, stripping a trailing slash", () => {
    expect(parseSearxngUrl("https://search.example/")).toBe("https://search.example");
    expect(parseSearxngUrl("http://127.0.0.1:8080/search")).toBe("http://127.0.0.1:8080/search");
    expect(searxngUrlFromEnv({ JUMI_SEARXNG_URL: "https://search.example" })).toBe("https://search.example");
  });

  test("rejects a non-http(s) value naming the variable", () => {
    for (const bad of ["ftp://search.example", "gopher://x", "not a url", "file:///etc/passwd"]) {
      expect(() => parseSearxngUrl(bad)).toThrow("JUMI_SEARXNG_URL");
    }
    expect(() => searxngUrlFromEnv({ JUMI_SEARXNG_URL: "ftp://x" })).toThrow("JUMI_SEARXNG_URL");
  });

  test("the timeout is fifteen seconds", () => {
    expect(SEARXNG_TIMEOUT_MS).toBe(15_000);
  });
});

describe("normalizeMaxResults", () => {
  test("defaults to eight and caps at twenty", () => {
    expect(normalizeMaxResults(undefined)).toBe(SEARXNG_DEFAULT_RESULTS);
    expect(normalizeMaxResults(null)).toBe(SEARXNG_DEFAULT_RESULTS);
    expect(normalizeMaxResults(3)).toBe(3);
    expect(normalizeMaxResults(20)).toBe(SEARXNG_MAX_RESULTS);
    expect(normalizeMaxResults(99)).toBe(SEARXNG_MAX_RESULTS);
    expect(normalizeMaxResults(0)).toBe(1);
    expect(() => normalizeMaxResults("zzz")).toThrow(SearxngError);
  });
});

describe("isForgeSearchResult", () => {
  test("drops the apex and its subdomains only", () => {
    expect(isForgeSearchResult("https://gitea.example.com/issues/1", "gitea.example.com")).toBe(true);
    expect(isForgeSearchResult("https://api.gitea.example.com/y", "gitea.example.com")).toBe(true);
    expect(isForgeSearchResult("https://docs.example.com/x", "gitea.example.com")).toBe(false);
    expect(isForgeSearchResult("https://gitea.example.com.evil.com/", "gitea.example.com")).toBe(false);
    expect(isForgeSearchResult("not a url", "gitea.example.com")).toBe(false);
  });
});

describe("formatSearxngResult", () => {
  test("renders title, URL and a capped snippet, nothing else", () => {
    const out = formatSearxngResult({ title: "T", url: "https://x/", snippet: "S" }, 0);
    expect(out).toContain("T");
    expect(out).toContain("https://x/");
    expect(out).toContain("S");
    expect(out).not.toContain("score");
  });
});

describe("querySearxng", () => {
  async function withStub(
    handler: (req: Request) => Response | Promise<Response>,
    run: (base: string) => Promise<void>
  ): Promise<void> {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seen.push(new URL(req.url).pathname + new URL(req.url).search);
        return handler(req);
      },
    });
    try {
      await run(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
    expect(seen[0] ?? "").toMatch(/^\/search\?q=/);
    expect(seen[0] ?? "").toContain("format=json");
  }

  test("returns title, URL and snippet for a stub JSON reply", async () => {
    await withStub(
      () =>
        Response.json({
          results: [{ title: "Upstream", url: "https://docs.example.com/x", content: "  hello   world  " }],
        }),
      async (base) => {
        const results = await querySearxng(base, "query", 8, "gitea.example.com");
        expect(results).toEqual([{ title: "Upstream", url: "https://docs.example.com/x", snippet: "hello world" }]);
      }
    );
  });

  test("respects max_results and drops the forge host", async () => {
    await withStub(
      () =>
        Response.json({
          results: [
            { title: "A", url: "https://a.example.com/", content: "a" },
            { title: "Forge", url: "https://gitea.example.com/issues/1", content: "f" },
            { title: "B", url: "https://b.example.com/", content: "b" },
          ],
        }),
      async (base) => {
        const one = await querySearxng(base, "q", 1, "gitea.example.com");
        expect(one.map((r) => r.url)).toEqual(["https://a.example.com/"]);
        const all = await querySearxng(base, "q", 8, "gitea.example.com");
        expect(all.map((r) => r.url)).toEqual(["https://a.example.com/", "https://b.example.com/"]);
      }
    );
  });

  test("a connection refusal is a tool error that says so", async () => {
    await expect(querySearxng("http://127.0.0.1:9", "q", 8, "gitea.example.com")).rejects.toThrow(
      /cannot reach http:\/\/127\.0\.0\.1:9/
    );
  });

  test("a non-200 reply is a tool error naming the status", async () => {
    await withStub(
      () => new Response("no", { status: 500 }),
      async (base) => {
        await expect(querySearxng(base, "q", 8, "gitea.example.com")).rejects.toThrow(/answered 500/);
      }
    );
    await withStub(
      () => new Response("no", { status: 403 }),
      async (base) => {
        await expect(querySearxng(base, "q", 8, "gitea.example.com")).rejects.toThrow(/403.*search\.formats/);
      }
    );
  });

  test("an unexpected shape is a tool error", async () => {
    await withStub(
      () => Response.json({ foo: 1 }),
      async (base) => {
        await expect(querySearxng(base, "q", 8, "gitea.example.com")).rejects.toThrow(/unexpected reply/);
      }
    );
  });

  test("a timeout is a tool error, never a hang", async () => {
    const hanging = (_input: string, init?: { signal?: AbortSignal | null }): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    await expect(
      querySearxng("http://127.0.0.1:9", "q", 8, "gitea.example.com", hanging as typeof fetch, 50)
    ).rejects.toThrow(/timed out/);
  });

  test("an empty query is rejected", async () => {
    await expect(querySearxng("http://127.0.0.1:9", "  ", 8, "gitea.example.com")).rejects.toThrow(/must not be empty/);
  });
});

describe("per-runner MCP registration", () => {
  test("the server path is absolute and lives beside the sources", () => {
    expect(searxngServerPath()).toBe(
      join(searxngServerPath().replace(/\/searxng_server\.ts$/, ""), "searxng_server.ts")
    );
    expect(Bun.file(searxngServerPath()).size).toBeGreaterThan(0);
  });

  test("codex args pin bun, the server file, and only the two server env vars", () => {
    const args = codexSearxngArgs("https://search.example", "gitea.example.com");
    expect(args).toContain(`mcp_servers.${SEARXNG_SERVER_NAME}.command="bun"`);
    const at = args.indexOf(`mcp_servers.${SEARXNG_SERVER_NAME}.args=["${searxngServerPath()}"]`);
    expect(at).toBeGreaterThan(-1);
    const envArg =
      args[
        args.indexOf(
          `mcp_servers.${SEARXNG_SERVER_NAME}.env={ ${SEARXNG_SERVER_URL_ENV} = "https://search.example", ${SEARXNG_SERVER_FORGE_HOST_ENV} = "gitea.example.com" }`
        )
      ];
    expect(envArg).toContain(SEARXNG_SERVER_URL_ENV);
    expect(envArg).toContain(SEARXNG_SERVER_FORGE_HOST_ENV);
  });

  test("opencode registration is a local stdio server with the same two env vars", () => {
    const server = openCodeSearxngServer("https://search.example", "gitea.example.com") as Record<string, unknown>;
    expect(server.type).toBe("local");
    expect(server.command).toEqual(["bun", searxngServerPath()]);
    expect(server.environment).toEqual({
      [SEARXNG_SERVER_URL_ENV]: "https://search.example",
      [SEARXNG_SERVER_FORGE_HOST_ENV]: "gitea.example.com",
    });
  });

  test("runner tool names follow each harness convention", () => {
    expect(SEARXNG_TOOL_NAME).toBe("search");
    expect(SEARXNG_CLAUDE_TOOL).toBe("mcp__searxng__search");
    expect(SEARXNG_OPENCODE_TOOL).toBe("searxng_search");
  });
});

describe("the bundled MCP server", () => {
  test("exposes exactly one tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "searxng-mcp-"));
    try {
      const proc = Bun.spawn(["bun", searxngServerPath()], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SEARXNG_URL: "http://127.0.0.1:9", SEARXNG_FORGE_HOST: "example.com" },
      });
      const writer = proc.stdin;
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      const send = (msg: unknown) =>
        (writer as unknown as { write: (c: Uint8Array) => void }).write(
          new TextEncoder().encode(`${JSON.stringify(msg)}\n`)
        );
      const readOne = async (): Promise<unknown> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("eof");
          buf += new TextDecoder().decode(value);
          const i = buf.indexOf("\n");
          if (i >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) return JSON.parse(line);
          }
        }
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await readOne();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = (await readOne()) as { result: { tools: { name: string }[] } };
      expect(listed.result.tools.map((t) => t.name)).toEqual([SEARXNG_TOOL_NAME]);
      proc.kill();
      await proc.exited.catch(() => undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runner web capabilities", () => {
  test("opencode searches natively and fetches; configured it uses searxng", () => {
    expect(webCapabilitiesForRunner("opencode", false)).toEqual({ search: "native", fetch: true });
    expect(webCapabilitiesForRunner("opencode", true)).toEqual({ search: "searxng", fetch: true });
    expect(webCapabilitiesForRunner(undefined, false)).toEqual({ search: "native", fetch: true });
  });

  test("claude fetches and only searches when configured", () => {
    expect(webCapabilitiesForRunner("claude", false)).toEqual({ search: null, fetch: true });
    expect(webCapabilitiesForRunner("claude", true)).toEqual({ search: "searxng", fetch: true });
  });

  test("codex searches but never fetches", () => {
    expect(webCapabilitiesForRunner("codex", false)).toEqual({ search: "native", fetch: false });
    expect(webCapabilitiesForRunner("codex", true)).toEqual({ search: "searxng", fetch: false });
  });

  test("agy fetches and only searches when configured", () => {
    expect(webCapabilitiesForRunner("agy", false)).toEqual({ search: null, fetch: true });
    expect(webCapabilitiesForRunner("agy", true)).toEqual({ search: "searxng", fetch: true });
  });

  test("guidance names the runner's tools and the find-then-fetch rule", () => {
    const both = webEvidenceGuidance("opencode", { search: "searxng", fetch: true });
    expect(both).toContain("`searxng_search`");
    expect(both).toContain("`webfetch`");
    expect(both).toContain("do not construct file or release URLs from memory");
    const codex = webEvidenceGuidance("codex", { search: "native", fetch: false });
    expect(codex).toContain("no fetch tool");
    expect(codex).not.toContain("fetch that exact URL with");
    const fetchOnly = webEvidenceGuidance("claude", { search: null, fetch: true });
    expect(fetchOnly).toContain("no web search tool");
    expect(fetchOnly).toContain("`WebFetch`");
  });
});
