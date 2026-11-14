import { describe, expect, test } from "bun:test";
import { buildPullRequestBody, rewriteClosingToRefs } from "../src/implement.ts";
import { resolveClosingIssuesForReview } from "../src/review.ts";
import { makePR } from "./fixtures.ts";

describe("resolveClosingIssuesForReview", () => {
  test("GitHub path uses the forge list even when the body only closes in a code span", async () => {
    const pr = makePR({ body: "`Fixes #12`\n\nSome work" });
    const forge = {
      listClosingIssues: async () => [12],
    };
    const result = await resolveClosingIssuesForReview({
      forge,
      owner: "o",
      repo: "r",
      prNumber: pr.number,
      pr,
      log: () => undefined,
    });
    expect(result).toEqual({ issues: [12], source: "forge" });
  });

  test("Gitea fallback uses the parser, which ignores code spans and quotes", async () => {
    const plain = makePR({ body: "Fixes #12" });
    const fallbackPlain = await resolveClosingIssuesForReview({
      forge: {},
      owner: "o",
      repo: "r",
      prNumber: plain.number,
      pr: plain,
      log: () => undefined,
    });
    expect(fallbackPlain).toEqual({ issues: [12], source: "fallback" });

    const quoted = makePR({ body: "> Fixes #12" });
    const fallbackQuoted = await resolveClosingIssuesForReview({
      forge: {},
      owner: "o",
      repo: "r",
      prNumber: quoted.number,
      pr: quoted,
      log: () => undefined,
    });
    expect(fallbackQuoted).toEqual({ issues: [], source: "fallback" });
  });

  test("a throwing forge list falls back to the parser", async () => {
    const pr = makePR({ body: "Fixes #13" });
    const forge = {
      listClosingIssues: async () => {
        throw new Error("graphql boom");
      },
    };
    const result = await resolveClosingIssuesForReview({
      forge,
      owner: "o",
      repo: "r",
      prNumber: pr.number,
      pr,
      log: () => undefined,
    });
    expect(result).toEqual({ issues: [13], source: "fallback" });
  });
});

describe("closing rewrite keeps ignored ranges", () => {
  test("rewriteClosingToRefs leaves code spans and quotes alone", () => {
    expect(rewriteClosingToRefs("`Fixes #12`", 12)).toBe("`Fixes #12`");
    expect(rewriteClosingToRefs("> Fixes #12", 12)).toBe("> Fixes #12");
    expect(rewriteClosingToRefs("Fixes #12", 12)).toBe("Refs #12");
    expect(rewriteClosingToRefs("`Fixes #12`\nFixes #12", 12)).toBe("`Fixes #12`\nRefs #12");
  });

  test("PR body build appends a fallback when the only keyword is ignored", () => {
    expect(buildPullRequestBody(12, "`Fixes #12`")).toBe("`Fixes #12`\n\nFixes #12");
    expect(buildPullRequestBody(12, "> Fixes #12")).toBe("> Fixes #12\n\nFixes #12");
    expect(buildPullRequestBody(12, "Fixes #12")).toBe("Fixes #12");
  });
});
