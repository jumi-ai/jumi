import { describe, expect, test } from "bun:test";
import { gitOpsBumpVerdict, isJumiDockerBump, parseGitOpsSection } from "../src/gitops_notes.ts";

describe("GitOps notes", () => {
  test("missing section → yellow", () => {
    expect(parseGitOpsSection("## Changes\n- digest only")).toEqual({ kind: "missing" });
    expect(
      gitOpsBumpVerdict({
        notes: { kind: "missing" },
        chartOrValuesEdited: false,
      })
    ).toEqual({ severity: "yellow", reason: "no GitOps notes; cannot tell if values need edits" });
  });

  test("none + digest-only → no extra red", () => {
    const body = "## GitOps\nnone\n\n## Breaking\nnone\n\n## Changes\n- bump digest\n";
    expect(parseGitOpsSection(body)).toEqual({ kind: "none" });
    expect(
      gitOpsBumpVerdict({
        notes: { kind: "none" },
        chartOrValuesEdited: false,
      })
    ).toEqual({ severity: "none" });
  });

  test("required GitOps bullets without chart/values edits → red", () => {
    const body = `## GitOps
### reviewer
- **requires** \`FOO\` (new; missing → crash)
### worker
- none
`;
    expect(parseGitOpsSection(body).kind).toBe("items");
    expect(
      gitOpsBumpVerdict({
        notes: parseGitOpsSection(body),
        chartOrValuesEdited: false,
      }).severity
    ).toBe("red");
    expect(
      gitOpsBumpVerdict({
        notes: parseGitOpsSection(body),
        chartOrValuesEdited: true,
      })
    ).toEqual({ severity: "none" });
  });

  test("detects Renovate jumi docker bumps from title/body", () => {
    expect(
      isJumiDockerBump(
        "chore(deps): update gitea.kirmanak.stream/personal/jumi-reviewer digest to abcdef",
        "depName: gitea.kirmanak.stream/personal/jumi-reviewer"
      )
    ).toBe(true);
    expect(isJumiDockerBump("Update jumi-worker digest to 123", "Renovate digest bump")).toBe(true);
    expect(isJumiDockerBump("Fix queue", "no images")).toBe(false);
  });
});
