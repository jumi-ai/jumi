import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEYS } from "../src/repo_settings.ts";
import { WORKER_MCP_TOOL_NAMES } from "../src/worker_mcp.ts";

const readme = readFileSync(join(process.cwd(), "..", "..", "README.md"), "utf8");

describe("readme drift guards", () => {
  test("named .jumi.yml keys are a subset of the parser registry, full list linked", () => {
    const marker = "<!-- readme-drift: repo-settings-keys -->";
    const start = readme.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const section = readme.slice(start, start + 2000);
    expect(section).toContain("docs/repo-settings.md");
    const named = [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(0);
    for (const key of named) {
      expect(KNOWN_KEYS.has(key)).toBe(true);
    }
  });

  test("worker MCP tools are named", () => {
    for (const tool of WORKER_MCP_TOOL_NAMES) {
      expect(readme).toContain(`\`${tool}\``);
    }
  });

  test("review verdict names the structured tools", () => {
    for (const tool of ["add_finding", "set_verdict"]) {
      expect(readme).toContain(`\`${tool}\``);
    }
  });
});
