import { describe, expect, test } from "bun:test";
import { buildPROpenedPrompt, REVIEW_RUBRIC } from "../src/prompt.ts";
import {
  buildWorkerReviewRulesSection,
  loadFollowupReviewRules,
  loadWorkerReviewRules,
  selectWorkerReviewMdSections,
  WORKER_REVIEW_RULES_CHECK,
} from "../src/worker_review_rules.ts";
import { makeFile, makePR, makeRepo } from "./fixtures.ts";

const REVIEW = `# Review rules

Intro for every review.

## Security

Never log tokens.

## Not a finding

Pre-existing behavior the diff leaves unchanged.

## k3s/**, **/Chart.yaml

Bump the checksum annotation.
`;

describe("worker review rules share the reviewer's rubric source", () => {
  test("the worker block embeds REVIEW_RUBRIC verbatim", () => {
    const selection = selectWorkerReviewMdSections(REVIEW, undefined);
    const section = buildWorkerReviewRulesSection(selection);
    expect(section).toContain(REVIEW_RUBRIC);
  });

  test("the reviewer prompt is built from the same REVIEW_RUBRIC", () => {
    const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
    expect(prompt).toContain(REVIEW_RUBRIC);
    const selection = selectWorkerReviewMdSections(REVIEW, undefined);
    const section = buildWorkerReviewRulesSection(selection);
    // Same source: the exact rubric text appears in both.
    expect(section).toContain(REVIEW_RUBRIC);
    expect(prompt).toContain(REVIEW_RUBRIC);
  });

  test("the worker is told to check the diff and name unmet rules in the PR body", () => {
    const selection = selectWorkerReviewMdSections(REVIEW, undefined);
    const section = buildWorkerReviewRulesSection(selection);
    expect(section).toContain(WORKER_REVIEW_RULES_CHECK);
    expect(section).toContain("set_pr_body");
  });
});

describe("selectWorkerReviewMdSections", () => {
  test("implement (no files) gets repo-wide plus all path sections", () => {
    const selection = selectWorkerReviewMdSections(REVIEW, undefined);
    expect(selection.text).toContain("Never log tokens.");
    expect(selection.text).toContain("Bump the checksum annotation.");
    expect(selection.pathSections).toBe(1);
    expect(selection.matchedPathSections).toBe(1);
  });

  test("follow-up selects path sections by the PR's changed files", () => {
    const matched = selectWorkerReviewMdSections(REVIEW, [makeFile({ filename: "k3s/a.yaml" })]);
    expect(matched.text).toContain("Bump the checksum annotation.");
    const unmatched = selectWorkerReviewMdSections(REVIEW, [makeFile({ filename: "src/index.ts" })]);
    expect(unmatched.text).not.toContain("Bump the checksum annotation.");
    expect(unmatched.text).toContain("Never log tokens.");
  });

  test("the reviewer-only Not a finding section is absent from the worker copy", () => {
    for (const files of [undefined, [makeFile({ filename: "src/index.ts" })]] as Array<
      undefined | Array<ReturnType<typeof makeFile>>
    >) {
      const selection = selectWorkerReviewMdSections(REVIEW, files);
      expect(selection.text).not.toContain("Not a finding");
      expect(selection.text).not.toContain("Pre-existing behavior");
    }
  });
});

describe("loadWorkerReviewRules", () => {
  const settingsOn = { state: "valid", workerReviewRules: true } as never;
  const settingsOff = { state: "valid", workerReviewRules: false } as never;

  test("a repo with no REVIEW.md gets nothing", async () => {
    const section = await loadWorkerReviewRules({
      api: { getRepoFile: async () => ({ found: false }) },
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOn,
      files: undefined,
    });
    expect(section).toBeUndefined();
  });

  test("the switch off gets nothing even when REVIEW.md exists", async () => {
    const section = await loadWorkerReviewRules({
      api: { getRepoFile: async () => ({ found: true, content: REVIEW }) },
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOff,
      files: undefined,
    });
    expect(section).toBeUndefined();
  });

  test("switch on shares the rules with the rubric", async () => {
    const section = await loadWorkerReviewRules({
      api: { getRepoFile: async () => ({ found: true, content: REVIEW }) },
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOn,
      files: undefined,
    });
    expect(section).toBeDefined();
    expect(section ?? "").toContain(REVIEW_RUBRIC);
    expect(section ?? "").toContain("Never log tokens.");
    expect(section ?? "").not.toContain("Not a finding");
  });
});

describe("loadFollowupReviewRules", () => {
  const settingsOn = { state: "valid", workerReviewRules: true } as never;

  function apiWith(reviewMd: string, files: Array<{ filename: string }>) {
    return {
      getRepoFile: async () => ({ found: true, content: reviewMd }),
      getPRFiles: async () => files,
    };
  }

  test("follow-up selects sections by the PR's changed files", async () => {
    const matched = await loadFollowupReviewRules({
      api: apiWith(REVIEW, [{ filename: "k3s/a.yaml" }]) as never,
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOn,
      prNumber: 7,
    });
    expect(matched ?? "").toContain("Bump the checksum annotation.");
    const unmatched = await loadFollowupReviewRules({
      api: apiWith(REVIEW, [{ filename: "src/index.ts" }]) as never,
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOn,
      prNumber: 7,
    });
    expect(unmatched ?? "").not.toContain("Bump the checksum annotation.");
    expect(unmatched ?? "").toContain("Never log tokens.");
  });

  test("follow-up leaves out Not a finding", async () => {
    const section = await loadFollowupReviewRules({
      api: apiWith(REVIEW, [{ filename: "src/index.ts" }]) as never,
      owner: "o",
      repo: "r",
      ref: "main",
      settings: settingsOn,
      prNumber: 7,
    });
    expect(section ?? "").not.toContain("Not a finding");
  });
});
