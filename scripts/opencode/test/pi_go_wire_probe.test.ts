/**
 * Negative controls for the Pi Go wire probe (jumi#986).
 *
 * `checkWireTools` is the assertion that fails the probe when a tool is
 * dropped from an intent's registration, renamed, or stripped of its
 * schema/description in serialization. These tests drive exactly those
 * mutations so the control cannot silently stop matching.
 */

import { describe, expect, test } from "bun:test";
import {
  checkWireTools,
  EXPECTED_BUILTIN_TOOLS,
  REVIEW_EXPECTED_JUMI_TOOLS,
  WIRE_TOOL_CONTRACTS,
  WORKER_EXPECTED_JUMI_TOOLS,
} from "../src/pi_go_wire_probe.ts";

function wireTool(name: string): Record<string, unknown> {
  const contract = WIRE_TOOL_CONTRACTS[name];
  if (!contract) throw new Error(`no contract for ${name}`);
  const properties: Record<string, { type: string }> = {};
  for (const [prop, type] of Object.entries(contract.propTypes)) properties[prop] = { type };
  return {
    type: "function",
    name,
    description: `${name} description`,
    parameters: { type: "object", required: [...contract.required], properties },
  };
}

function wireTools(names: readonly string[]): Array<Record<string, unknown>> {
  return [
    ...EXPECTED_BUILTIN_TOOLS.map((name) => ({
      type: "function",
      name,
      description: `${name} builtin`,
      parameters: { type: "object", required: [], properties: {} },
    })),
    ...names.map(wireTool),
  ];
}

describe("go wire tool declarations", () => {
  test("the declared review set matches the serialized registration", () => {
    expect(checkWireTools(wireTools(REVIEW_EXPECTED_JUMI_TOOLS), REVIEW_EXPECTED_JUMI_TOOLS)).toBeNull();
  });

  test("each declared worker intent set matches the serialized registration", () => {
    for (const expected of Object.values(WORKER_EXPECTED_JUMI_TOOLS)) {
      expect(checkWireTools(wireTools(expected), expected)).toBeNull();
    }
  });

  test("dropping one tool from one intent's registration fails", () => {
    const dropped = REVIEW_EXPECTED_JUMI_TOOLS.filter((name) => name !== "jumi_list_findings");
    expect(checkWireTools(wireTools(dropped), REVIEW_EXPECTED_JUMI_TOOLS)).toContain("jumi_list_findings");
    const workerDropped = (WORKER_EXPECTED_JUMI_TOOLS.implement ?? []).filter((name) => name !== "jumi_set_pr_body");
    expect(checkWireTools(wireTools(workerDropped), WORKER_EXPECTED_JUMI_TOOLS.implement ?? [])).toContain(
      "jumi_set_pr_body"
    );
  });

  test("renaming a tool fails", () => {
    const renamed = wireTools(REVIEW_EXPECTED_JUMI_TOOLS).map((tool) =>
      tool.name === "jumi_set_verdict" ? { ...tool, name: "jumi_set_verdict2" } : tool
    );
    expect(checkWireTools(renamed, REVIEW_EXPECTED_JUMI_TOOLS)).toContain("jumi_set_verdict");
  });

  test("an extra undeclared jumi_* tool fails", () => {
    const extra = [...wireTools(REVIEW_EXPECTED_JUMI_TOOLS)];
    extra.push({ type: "function", name: "jumi_new_tool", description: "new", parameters: { type: "object" } });
    expect(checkWireTools(extra, REVIEW_EXPECTED_JUMI_TOOLS)).toContain("jumi_new_tool");
  });

  test("stripping a description fails", () => {
    const stripped = wireTools(REVIEW_EXPECTED_JUMI_TOOLS).map((tool) =>
      tool.name === "jumi_add_finding" ? { ...tool, description: "  " } : tool
    );
    expect(checkWireTools(stripped, REVIEW_EXPECTED_JUMI_TOOLS)).toContain("jumi_add_finding");
  });

  test("stripping the schema fails", () => {
    const stripped = wireTools(REVIEW_EXPECTED_JUMI_TOOLS).map((tool) =>
      tool.name === "jumi_add_finding" ? { ...tool, parameters: { type: "object" } } : tool
    );
    // add_finding requires severity, so the missing required list must fail.
    expect(checkWireTools(stripped, REVIEW_EXPECTED_JUMI_TOOLS)).toContain("jumi_add_finding");
    // An empty-contract tool keeps passing with the same stripped shape.
    const listOnly: Array<Record<string, unknown>> = [
      {
        type: "function",
        name: "jumi_list_findings",
        description: "list",
        parameters: { type: "object" },
      },
    ];
    expect(checkWireTools(listOnly, ["jumi_list_findings"])).toBeNull();
  });

  test("dropping a required field or changing a property type fails", () => {
    const noRequired = wireTools(["jumi_set_pr_body"]).map((tool) => ({
      ...tool,
      parameters: { type: "object", required: [], properties: { markdown: { type: "string" } } },
    }));
    expect(checkWireTools(noRequired, ["jumi_set_pr_body"])).toContain("markdown");
    const wrongType = wireTools(["jumi_set_pr_body"]).map((tool) => ({
      ...tool,
      parameters: { type: "object", required: ["markdown"], properties: { markdown: { type: "number" } } },
    }));
    expect(checkWireTools(wrongType, ["jumi_set_pr_body"])).toContain("markdown");
  });

  test("an unexpected non-jumi tool fails while guarded built-ins pass", () => {
    const bad = [...wireTools(["jumi_set_pr_body"]), { type: "function", name: "grep", description: "search" }];
    expect(checkWireTools(bad, ["jumi_set_pr_body"])).toContain("grep");
    expect(checkWireTools("not-an-array", ["jumi_set_pr_body"])).not.toBeNull();
  });
});
