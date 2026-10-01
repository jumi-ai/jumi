import { describe, expect, test } from "bun:test";
import {
  findingFingerprint,
  keepReviewFindingLines,
  parseReviewFindings,
  parseReviewOutput,
  stripFindingLines,
  trailerSuggestionCount,
} from "../src/verdict.ts";

describe("parseReviewOutput", () => {
  test("reads an explicit success check and strips it from the comment", () => {
    expect(parseReviewOutput("Looks good.\n\nNo correctness bugs.\n<!-- jumi-check: success -->")).toEqual({
      comment: "Looks good.\n\nNo correctness bugs.",
      checkLine: "<!-- jumi-check: success -->",
      verdict: { state: "success", description: "No blocking issues", incomplete: false },
    });
  });

  test("reads an explicit failure check with a reason", () => {
    const output = [
      "L12: 🔴 bug: null deref. Guard it.",
      "L40: 🟡 risk: swallowed error. Fail closed.",
      "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
    ].join("\n");
    expect(parseReviewOutput(output)).toEqual({
      comment: "L12: 🔴 bug: null deref. Guard it.\nL40: 🟡 risk: swallowed error. Fail closed.",
      checkLine: "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
      verdict: { state: "failure", description: "1 blocking, 1 risk", incomplete: false },
    });
  });

  test("accepts a check comment only as the last non-empty line", () => {
    const output = [
      "Do not grep 🔴. Ask for `<!-- jumi-check: failure -->` instead.",
      "❓ q: why special-case 🔴?",
      "<!-- jumi-check: success -->",
    ].join("\n");
    expect(parseReviewOutput(output).verdict).toEqual({
      state: "success",
      description: "No blocking issues",
      incomplete: false,
    });
  });

  test("ignores a quoted check comment that is not the whole last line", () => {
    const output = ["<!-- jumi-check: failure; 1 risk -->", "example: <!-- jumi-check: success -->"].join("\n");
    expect(parseReviewOutput(output).verdict).toEqual({
      state: "failure",
      description: "Incomplete review: no check verdict",
      incomplete: true,
    });
  });

  test("fails closed when the last line is prose after a trailer", () => {
    const output = ["Looks good.", "<!-- jumi-check: success -->", "Hope this helps."].join("\n");
    expect(parseReviewOutput(output).verdict.incomplete).toBe(true);
  });

  test("fails closed when the check comment is missing", () => {
    expect(parseReviewOutput("Looks good.\n\nNo correctness bugs.")).toEqual({
      comment: "Looks good.\n\nNo correctness bugs.",
      verdict: { state: "failure", description: "Incomplete review: no check verdict", incomplete: true },
    });
  });

  test("fails empty output as incomplete", () => {
    expect(parseReviewOutput("   ")).toEqual({
      comment: "",
      verdict: { state: "failure", description: "Incomplete review: no output", incomplete: true },
    });
  });

  test("treats a stub without a check comment as incomplete", () => {
    expect(parseReviewOutput("I'll inspect the PR and check for correctness issues.").verdict).toEqual({
      state: "failure",
      description: "Incomplete review: no check verdict",
      incomplete: true,
    });
  });

  test("reads a success trailer with a suggestion count", () => {
    expect(parseReviewOutput("drop the helper\n<!-- jumi-check: success; 2 suggestions -->")).toEqual({
      comment: "drop the helper",
      checkLine: "<!-- jumi-check: success; 2 suggestions -->",
      verdict: { state: "success", description: "2 suggestions", incomplete: false },
    });
  });
});

describe("trailerSuggestionCount", () => {
  test("reads a positive count and ignores questions-only reasons", () => {
    expect(trailerSuggestionCount("2 suggestions")).toBe(2);
    expect(trailerSuggestionCount("1 suggestion")).toBe(1);
    expect(trailerSuggestionCount("no blocking issues")).toBe(0);
    expect(trailerSuggestionCount("0 suggestions")).toBe(0);
    expect(trailerSuggestionCount("")).toBe(0);
  });
});

describe("parseReviewFindings", () => {
  test("parses file:line findings and skips lines without a usable path or line", () => {
    const text = [
      "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      "No location on this sentence.",
      "deploy/contract.md:1: 🟡 risk: missing env.",
      "../secret:3: 🔴 bug: skip traversal.",
      "src/bar.ts:0: 🔴 bug: skip zero.",
      "- src/list.ts:9: 💡 simpler: drop the helper.",
    ].join("\n");
    expect(parseReviewFindings(text)).toEqual([
      { path: "src/foo.ts", line: 12, body: "🔴 bug: null deref. Guard it." },
      { path: "deploy/contract.md", line: 1, body: "🟡 risk: missing env." },
      { path: "src/list.ts", line: 9, body: "💡 simpler: drop the helper." },
    ]);
  });

  test("resolves L-form only when a single-file path is provided", () => {
    const text = "L12: 🔴 bug: null deref. Guard it.\nL40: ❓ q: why swallow errors?";
    expect(parseReviewFindings(text)).toEqual([]);
    expect(parseReviewFindings(text, { singleFilePath: "src/demo.ts" })).toEqual([
      { path: "src/demo.ts", line: 12, body: "🔴 bug: null deref. Guard it." },
      { path: "src/demo.ts", line: 40, body: "❓ q: why swallow errors?" },
    ]);
    expect(parseReviewFindings(text, { singleFilePath: "../oops.ts" })).toEqual([]);
  });

  test("strips locatable findings and keeps prose", () => {
    const text = [
      "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      "plain prose without a location",
      "L12: ❓ q: is the timeout intentional?",
    ].join("\n");
    expect(stripFindingLines(text)).toBe("plain prose without a location\nL12: ❓ q: is the timeout intentional?");
    expect(stripFindingLines(text, { singleFilePath: "src/demo.ts" })).toBe("plain prose without a location");
    expect(
      stripFindingLines(text, {
        posted: new Set([findingFingerprint("src/foo.ts", "🔴 bug: null deref. Guard it.")]),
      })
    ).toBe("plain prose without a location\nL12: ❓ q: is the timeout intentional?");
  });

  test("fingerprints findings by path and normalized text, not line", () => {
    expect(findingFingerprint("src/foo.ts", "🔴 bug: first.")).toBe(
      findingFingerprint("src/foo.ts", "🔴 bug: first.\n\n<!-- jumi-review:kirmanak/demo#7 -->")
    );
    expect(findingFingerprint("src/foo.ts", "🔴 bug: first.")).not.toBe(
      findingFingerprint("src/bar.ts", "🔴 bug: first.")
    );
  });
});

describe("keepReviewFindingLines", () => {
  test("drops a verification essay entirely", () => {
    const essay = [
      "## What I checked",
      "",
      "I read `src/review.ts` and traced `publishReviewResult` end to end.",
      "The diff adds a helper and wires it into the publish path.",
      "",
      "No blocking findings. No 🔴 or 🟡 issues on this SHA.",
    ].join("\n");
    expect(keepReviewFindingLines(essay)).toBe("");
  });

  test("keeps file:line and marker lines, drops the tour around them", () => {
    const text = [
      "## Summary",
      "This PR restates the diff in prose.",
      "",
      "- src/foo.ts:12: 🔴 bug: null deref. Guard it.",
      "- src/foo.ts:40: 💡 simpler: drop the helper.",
      "",
      "Verified the rest; nothing else stands out.",
      "",
      "❓ q: is the timeout intentional?",
      "🟡 risk: the retry swallows the error.",
    ].join("\n");
    expect(keepReviewFindingLines(text)).toBe(
      [
        "- src/foo.ts:12: 🔴 bug: null deref. Guard it.",
        "- src/foo.ts:40: 💡 simpler: drop the helper.",
        "",
        "❓ q: is the timeout intentional?",
        "🟡 risk: the retry swallows the error.",
      ].join("\n")
    );
  });

  test("keeps an L-line only on a single-file review or when it carries a marker", () => {
    expect(keepReviewFindingLines("L12: guard the null.", { singleFilePath: "src/demo.ts" })).toBe(
      "L12: guard the null."
    );
    expect(keepReviewFindingLines("L12: guard the null.")).toBe("");
    expect(keepReviewFindingLines("L12: 🔴 bug: null deref.")).toBe("L12: 🔴 bug: null deref.");
  });

  test("keeps a marker line whose location is backticked, bolded, or a range", () => {
    for (const line of [
      "`src/foo.ts:12`: 🔴 bug: null deref.",
      "**src/foo.ts:12**: 🔴 bug: null deref.",
      "src/foo.ts:12-14: 🔴 bug: null deref.",
      "- `L12`: 🟡 risk: retry swallows the error.",
    ]) {
      expect(keepReviewFindingLines(`Tour first.\n\n${line}`)).toBe(line);
    }
  });

  test("does not promote a narrated bug", () => {
    expect(keepReviewFindingLines("I think there might be a bug in the retry loop around line 40.")).toBe("");
  });

  test("keeps exact parent-authored lines", () => {
    const note = "This repository has no CI checks on this head.";
    expect(keepReviewFindingLines(`${note}\n\nLooks good overall.`, { keep: [note] })).toBe(note);
  });

  test("keeps a parent-authored note the child wrote as a bullet or inside a sentence", () => {
    const note = "This repository has no CI checks on this head.";
    expect(keepReviewFindingLines(`- ${note}\n\nLooks good overall.`, { keep: [note] })).toBe(note);
    expect(keepReviewFindingLines(`Note: ${note} I ran the tests locally.`, { keep: [note] })).toBe(note);
  });
});
