import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexArgv } from "../src/codex.ts";
import {
  judgeControl,
  judgeProduction,
  offeredTools,
  probeArgv,
  withoutWebSearchOverride,
} from "../src/codex_probe.ts";

const request = (tools: Record<string, string>[], marker = "JUMI-CODEX-CONFIG-PROBE-REACHED") =>
  JSON.stringify({ instructions: marker, tools });
const shell = { type: "function", name: "exec_command" };
const search = { type: "web_search" };
const report = (bodies: string[]) => ({ bodies, hookRan: true, mcpRan: true });
const failures = (results: { name: string; ok: boolean }[]) => results.filter((r) => !r.ok).map((r) => r.name);

describe("offeredTools", () => {
  test("reads names, falls back to the type, and skips a body it cannot parse", () => {
    expect(offeredTools([request([shell, search]), "not json"])).toEqual(["exec_command", "web_search"]);
  });
});

describe("judgeProduction", () => {
  test("passes with the checkout loaded and no web search", () => {
    expect(failures(judgeProduction(report([request([shell])])))).toEqual([]);
  });

  test("fails when the checkout's web search reached the model", () => {
    expect(failures(judgeProduction(report([request([shell, search])])))).toEqual([
      "web search stays off against the checkout's config",
    ]);
  });

  test("fails when no tool list arrived, instead of passing with nothing to judge", () => {
    expect(failures(judgeProduction(report([])))).toContain("web search stays off against the checkout's config");
  });

  test("fails when the checkout did not load", () => {
    const results = judgeProduction({ bodies: [request([shell], "")], hookRan: false, mcpRan: false });
    expect(failures(results)).toEqual([
      "the checkout's .codex/config.toml loads",
      "the checkout's hook runs",
      "the checkout's MCP server starts",
    ]);
  });
});

describe("judgeControl", () => {
  test("needs the checkout's web search to reach the model", () => {
    expect(judgeControl(report([request([shell, search])])).ok).toBe(true);
    expect(judgeControl(report([request([shell])])).ok).toBe(false);
  });
});

describe("the argv under test", () => {
  const argv = codexArgv({ prompt: "", model: "gpt-5.5", workdir: "/work" });

  test("keeps every production flag and moves only the provider", () => {
    const probed = probeArgv(argv, "http://127.0.0.1:1");
    expect(probed).not.toContain('model_provider="openai"');
    expect(probed).not.toContain("-");
    expect(probed).toContain('model_providers.jumiprobe.base_url="http://127.0.0.1:1/v1"');
    for (const arg of argv.filter((value) => value !== "-" && value !== 'model_provider="openai"')) {
      expect(probed).toContain(arg);
    }
  });

  test("the control drops only the web search override", () => {
    const control = withoutWebSearchOverride(argv);
    expect(control).toHaveLength(argv.length - 2);
    expect(control).not.toContain('web_search="disabled"');
  });

  test("refuses to run against an argv it no longer recognizes", () => {
    expect(() => probeArgv(["codex", "exec"], "http://127.0.0.1:1")).toThrow(/model_provider/);
    expect(() => withoutWebSearchOverride(["codex", "exec"])).toThrow(/web_search/);
  });
});

describe("image verification paths", () => {
  test("runs the codex probe in every image verification path", () => {
    const repoRoot = join(process.cwd(), "../..");
    for (const path of [
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
    ]) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/codex_probe.ts");
    }
    const checks = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checks.split("bun src/codex_probe.ts").length - 1).toBe(2);
  });
});
