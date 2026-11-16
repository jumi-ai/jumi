import { describe, expect, test } from "bun:test";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";

const PATCH = ["@@ -1,3 +1,5 @@", " context", "-old", "+new line two", "+new line three", " context", " tail"].join(
  "\n"
);

function makeStore(extra?: {
  changedFiles?: { filename: string; patch?: string }[];
  excludedFiles?: string[];
  previousFindings?: string[];
}) {
  return new ReviewVerdictStore({
    changedFiles: extra?.changedFiles ?? [{ filename: "src/a.ts", patch: PATCH }],
    ...(extra?.excludedFiles ? { excludedFiles: extra.excludedFiles } : {}),
    ...(extra?.previousFindings ? { previousFindings: extra.previousFindings } : {}),
  });
}

describe("ReviewVerdictStore validation", () => {
  test("rejects a path not in the pull", () => {
    const store = makeStore();
    const out = store.addFinding({ path: "src/other.ts", line: 2, severity: "bug", body: "broken" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/not in pull/);
  });

  test("rejects an excluded path", () => {
    const store = makeStore({
      changedFiles: [
        { filename: "src/a.ts", patch: PATCH },
        { filename: "gen/out.ts", patch: PATCH },
      ],
      excludedFiles: ["gen/out.ts"],
    });
    const out = store.addFinding({ path: "gen/out.ts", line: 2, severity: "risk", body: "fragile" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/excluded/);
  });

  test("rejects a line outside the hunks", () => {
    const store = makeStore();
    const out = store.addFinding({ path: "src/a.ts", line: 999, severity: "bug", body: "broken" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/outside hunks/);
  });

  test("rejects a bad severity", () => {
    const store = makeStore();
    const out = store.addFinding({ path: "src/a.ts", line: 2, severity: "nit", body: "style" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/bad severity/);
  });

  test("rejects success with an open risk", () => {
    const store = makeStore();
    const added = store.addFinding({ path: "src/a.ts", line: 2, severity: "risk", body: "race" });
    expect(added.ok).toBe(true);
    const verdict = store.setVerdict({ state: "success" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/open bug\/risk/);
  });

  test("rejects failure with nothing and no could-not-finish reason", () => {
    const store = makeStore();
    const verdict = store.setVerdict({ state: "failure", reason: "1 risk" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/could-not-finish/);
  });

  test("accepts failure with a could-not-finish reason and no findings", () => {
    const store = makeStore();
    const verdict = store.setVerdict({ state: "failure", reason: "could not finish: dirty tree" });
    expect(verdict.ok).toBe(true);
  });

  test("last verdict wins", () => {
    const store = makeStore();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "broken" }).ok).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    store.removeFinding({ id: "f1" });
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.getVerdict()).toEqual({ state: "success" });
  });

  test("a blocking finding recorded after success clears the verdict", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "broken" }).ok).toBe(true);
    expect(store.getVerdict()).toBeUndefined();
    expect(store.hasVerdict()).toBe(false);
    expect(store.openBlockingCount()).toBe(1);
    expect(store.toMarkdown()).toContain("Incomplete review: no verdict");
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
  });

  test("escalating a finding to bug after success clears the verdict", () => {
    const store = makeStore();
    const added = store.addFinding({ path: "src/a.ts", line: 2, severity: "question", body: "why?" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.updateFinding({ id: added.id, severity: "risk" }).ok).toBe(true);
    expect(store.getVerdict()).toBeUndefined();
  });

  test("a non-blocking finding recorded after success keeps the verdict", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "suggestion", body: "nit" }).ok).toBe(true);
    expect(store.getVerdict()).toEqual({ state: "success" });
  });

  test("update and remove round-trip, unknown id rejected", () => {
    const store = makeStore();
    const added = store.addFinding({ path: "src/a.ts", line: 2, severity: "question", body: "why?" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(store.updateFinding({ id: added.id, severity: "bug", line: 3 }).ok).toBe(true);
    expect(store.updateFinding({ id: "nope", severity: "bug" }).ok).toBe(false);
    expect(store.removeFinding({ id: added.id }).ok).toBe(true);
    expect(store.removeFinding({ id: added.id }).ok).toBe(false);
  });

  test("calls after close are rejected", () => {
    const store = makeStore();
    store.close();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "x" }).ok).toBe(false);
    expect(store.setVerdict({ state: "success" }).ok).toBe(false);
    expect(store.listFindings()).toEqual([]);
  });

  test("markdown round-trips through the file parsers", async () => {
    const store = makeStore();
    expect(
      store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." }).ok
    ).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "1 blocking" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const { parseReviewFindings, parseReviewOutput } = await import("../src/verdict.ts");
    expect(parseReviewFindings(markdown)).toHaveLength(1);
    expect(parseReviewFindings(markdown)[0].path).toBe("src/a.ts");
    expect(parseReviewOutput(markdown).verdict.state).toBe("failure");
  });

  test("a success reason with -> round-trips as success instead of incomplete", async () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success", reason: "bump 0.167.1->0.167.2, a >= b" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const { parseReviewOutput } = await import("../src/verdict.ts");
    expect(parseReviewOutput(markdown).verdict).toEqual({
      state: "success",
      description: "bump 0.167.1→0.167.2, a ›= b",
      incomplete: false,
    });
  });

  test("a reason with a newline and a literal --> stays a single parseable trailer line", async () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success", reason: "bump 0.167.1->0.167.2\nliteral --> here" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const lines = markdown.split("\n");
    expect(lines).toHaveLength(1);
    const { parseCheckLine, parseReviewOutput } = await import("../src/verdict.ts");
    const reason = parseCheckLine(lines[0])?.reason ?? "";
    expect(reason).not.toContain(">");
    expect(reason).not.toContain("\n");
    const parsed = parseReviewOutput(markdown);
    expect(parsed.verdict.state).toBe("success");
    expect(parsed.verdict.incomplete).toBe(false);
    expect(parsed.checkLine).toBe(lines[0]);
  });

  test("maintainer and simpler markers publish exactly once each", async () => {
    const store = makeStore();
    expect(
      store.addFinding({
        path: "src/a.ts",
        line: 2,
        severity: "question",
        title: "❓ maintainer: please close the other issue?",
      }).ok
    ).toBe(true);
    expect(
      store.addFinding({ path: "src/a.ts", line: 3, severity: "suggestion", title: "💡 simpler: extract a helper" }).ok
    ).toBe(true);
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const { countMaintainerQuestionFindings, isMaintainerQuestionFirstLine } = await import("../src/verdict.ts");
    expect(markdown).toContain("❓ maintainer: please close the other issue?");
    expect(markdown).toContain("💡 simpler: extract a helper");
    expect(markdown).not.toContain("❓ q: ❓ maintainer:");
    expect(markdown).not.toContain("💡 simpler: 💡 simpler:");
    const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
    expect(occurrences(markdown, "❓ maintainer:")).toBe(1);
    expect(occurrences(markdown, "💡 simpler:")).toBe(1);
    const maintainerLine = markdown.split("\n").find((line) => line.includes("❓ maintainer:")) ?? "";
    expect(isMaintainerQuestionFirstLine(maintainerLine)).toBe(true);
    expect(countMaintainerQuestionFindings(markdown)).toBe(1);
    const record = store.toRecord();
    expect(record.counts.question).toBe(1);
    expect(record.counts.maintainerQuestion).toBe(1);
  });
});
