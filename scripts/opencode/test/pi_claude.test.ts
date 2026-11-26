import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPiClaudeArgv,
  buildPiClaudeEnv,
  classifyPiClaudeError,
  hasPiClaudeUsage,
  PI_CLAUDE_COMMAND,
  PI_CLAUDE_ENDPOINT,
  PI_CLAUDE_JOB_BLOCKED_REASON,
  PI_CLAUDE_MODEL,
  PI_CLAUDE_OPERATOR_CHECKS,
  PI_CLAUDE_PINNED_CLI,
  PI_CLAUDE_PINNED_PI,
  PI_CLAUDE_PROFILE,
  PI_CLAUDE_PROVIDER,
  PI_CLAUDE_ROUTE_NAME,
  parsePiClaudeEffort,
  piClaudeUsageFromPayload,
  refusePiClaudeJobMode,
} from "../src/pi_claude.ts";
import { KNOWN_PI_ENDPOINTS, piAllowedRoutesFromEnv, resolvePiProfile, selectPiRoute } from "../src/pi_profiles.ts";

function claudeCatalog() {
  return { [PI_CLAUDE_ROUTE_NAME]: { ...PI_CLAUDE_PROFILE } };
}

describe("pi claude route", () => {
  test("route is disabled by default and needs an explicit allowlist entry", () => {
    expect(piAllowedRoutesFromEnv({})).toEqual([]);
    expect(() => selectPiRoute(PI_CLAUDE_ROUTE_NAME, claudeCatalog(), [])).toThrow();
    const route = selectPiRoute(PI_CLAUDE_ROUTE_NAME, claudeCatalog(), [PI_CLAUDE_ROUTE_NAME]);
    expect(route.provider).toBe(PI_CLAUDE_PROVIDER);
    expect(route.model).toBe(PI_CLAUDE_MODEL);
  });

  test("local helper endpoint is known; profile trains on nothing private", () => {
    expect(KNOWN_PI_ENDPOINTS).toContain(PI_CLAUDE_ENDPOINT);
    const route = resolvePiProfile(PI_CLAUDE_ROUTE_NAME, claudeCatalog());
    expect(route.endpoint).toBe("process://claude-code");
    expect(route.scopes).toEqual(["public"]);
    expect(route.payer).toBe("claude-subscription");
    expect(route.credentialRef).not.toMatch(/sk-ant-|token=.+/i);
  });

  test("production argv keeps Pi owning tools (no helper tools, no MCP, no skills)", () => {
    const argv = buildPiClaudeArgv({ model: PI_CLAUDE_MODEL });
    expect(argv[0]).toBe(PI_CLAUDE_COMMAND);
    expect(parsePiClaudeEffort(undefined)).toBeUndefined();
    expect(parsePiClaudeEffort("high")).toBe("high");
    expect(() => parsePiClaudeEffort("hihg")).toThrow();
    expect(PI_CLAUDE_OPERATOR_CHECKS.join("\n")).toMatch(/\/logout/);
    expect(argv).toContain("-p");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--mcp-config");
    const toolsAt = argv.indexOf("--tools");
    expect(argv[toolsAt + 1]).toBe("");
  });

  test("helper env never forwards tokens and refuses reroutes", () => {
    const env = buildPiClaudeEnv("/tmp/probe-home", { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(() => buildPiClaudeEnv("/tmp/h", { PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "x" })).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/
    );
    expect(() => buildPiClaudeEnv("/tmp/h", { PATH: "/usr/bin:/bin", ANTHROPIC_AUTH_TOKEN: "x" })).toThrow(
      /ANTHROPIC_AUTH_TOKEN/
    );
    expect(() => buildPiClaudeEnv("/tmp/h", { PATH: "/usr/bin:/bin", CLAUDE_CODE_USE_BEDROCK: "1" })).toThrow(
      /BEDROCK/
    );
    expect(() => buildPiClaudeEnv("/tmp/h", { PATH: "/usr/bin:/bin", GITEA_BOT_TOKEN: "x" })).toThrow(
      /GITEA_BOT_TOKEN/
    );
  });

  test("expiry stays distinct from quota and cancellation", () => {
    expect(classifyPiClaudeError("Not logged in · Please run /login")).toBe("auth-expired");
    expect(classifyPiClaudeError("authentication_failed")).toBe("auth-expired");
    expect(classifyPiClaudeError("Login expired")).toBe("auth-expired");
    expect(classifyPiClaudeError("Usage limit reached")).toBe("quota");
    expect(classifyPiClaudeError("AbortError: The operation was aborted")).toBe("cancelled");
    expect(classifyPiClaudeError("weird boom")).toBe("provider-failure");
    expect(classifyPiClaudeError("")).toBe("provider-failure");
  });

  test("cache usage reports unknown when absent, never zero", () => {
    expect(hasPiClaudeUsage(undefined)).toBe(false);
    expect(hasPiClaudeUsage(piClaudeUsageFromPayload({}))).toBe(false);
    const usage = piClaudeUsageFromPayload({ usage: { input_tokens: 7, output_tokens: 3 } })!;
    expect(hasPiClaudeUsage(usage)).toBe(true);
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(3);
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheWriteTokens).toBeUndefined();
    const cached = piClaudeUsageFromPayload({
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    })!;
    expect(cached.cacheReadTokens).toBe(5);
    expect(cached.cacheWriteTokens).toBe(2);
  });

  test("job mode stays blocked when the route is allowlisted", () => {
    expect(refusePiClaudeJobMode([]).refused).toBe(false);
    const refusal = refusePiClaudeJobMode([PI_CLAUDE_ROUTE_NAME]);
    expect(refusal.refused).toBe(true);
    expect(refusal.reason).toBe(PI_CLAUDE_JOB_BLOCKED_REASON);
  });

  test("pins match the shipped CLI and Pi SDK", async () => {
    const toolVersions = await readFile(join(import.meta.dir, "..", "..", "..", ".gitea", "tool-versions.env"), "utf8");
    expect(toolVersions).toContain(`CLAUDE_VERSION=${PI_CLAUDE_PINNED_CLI}`);
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBe(PI_CLAUDE_PINNED_PI);
  });
});
