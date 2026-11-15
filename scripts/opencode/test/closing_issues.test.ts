import { describe, expect, test } from "bun:test";
import { buildFollowupPrompt, buildImplementPrompt } from "../src/git.ts";
import {
  buildPullRequestBody,
  hasRemainingWorkList,
  rewriteClosingToRefs,
  rewriteRefsToClosing,
} from "../src/implement.ts";
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

describe("bare Refs without a remaining-work list cannot ship non-closing", () => {
  test("hasRemainingWorkList needs an explicit marker; prose alone does not count", () => {
    expect(hasRemainingWorkList("Refs #12")).toBe(false);
    expect(hasRemainingWorkList("Partial work.\n\nRefs #12")).toBe(false);
    expect(hasRemainingWorkList("Caches categories.\n\nRefs #12")).toBe(false);
    expect(hasRemainingWorkList("Refs #12\n\nRemaining:\n- one more case")).toBe(true);
    expect(hasRemainingWorkList("Refs #12\n\nTODO: backfill test")).toBe(true);
    expect(hasRemainingWorkList("Refs #12\n\n- [ ] backfill test")).toBe(true);
    expect(hasRemainingWorkList("Refs #12\n\nStill to do: backfill")).toBe(true);
    expect(hasRemainingWorkList("`Remaining`\n\nRefs #12")).toBe(false);
  });

  test("a bare Refs #N is rewritten to the closing keyword", () => {
    expect(rewriteRefsToClosing("Refs #12", 12)).toBe("Fixes #12");
    expect(rewriteRefsToClosing("`Refs #12`", 12)).toBe("`Refs #12`");
    expect(rewriteRefsToClosing("> Refs #12", 12)).toBe("> Refs #12");
    expect(rewriteRefsToClosing("Refs #13", 12)).toBe("Refs #13");
    expect(buildPullRequestBody(12, "Did the work.\n\nRefs #12")).toBe("Did the work.\n\nFixes #12");
    // No merged PR body from a bare Refs stays without a closing reference.
    expect(buildPullRequestBody(12, "Did the work.\n\nRefs #12")).toMatch(/fixes #12/i);
  });

  test("a Refs #N with an explicit remaining-work list is kept non-closing", () => {
    const body = buildPullRequestBody(12, "Did part.\n\nRefs #12\n\nRemaining:\n- one more case");
    expect(body).toBe("Did part.\n\nRefs #12\n\nRemaining:\n- one more case");
    expect(body).not.toMatch(/fixes #12/i);
  });

  test("closing_keyword refs behaviour is unchanged", () => {
    // Repos that stay open after merge keep Refs, and Fixes is rewritten to Refs.
    expect(buildPullRequestBody(12, "Did the work.\n\nRefs #12", undefined, [], "refs")).toBe(
      "Did the work.\n\nRefs #12"
    );
    expect(buildPullRequestBody(12, "Did the work.", undefined, [], "refs")).toBe("Did the work.\n\nRefs #12");
    expect(buildPullRequestBody(12, "Did the work.\n\nFixes #12", undefined, [], "refs")).toBe(
      "Did the work.\n\nRefs #12"
    );
  });

  test("worker prompts cover bare Refs and forge CI for CI-green Done items", () => {
    for (const prompt of [buildImplementPrompt(), buildFollowupPrompt()]) {
      expect(prompt).toContain("bare");
      expect(prompt).toContain("Refs #N");
      expect(prompt).toContain("remaining-work list");
      expect(prompt).toContain("forge's CI is what counts");
      expect(prompt).toContain("clean default-branch tree");
    }
  });
});
