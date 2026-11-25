import { describe, expect, test } from "bun:test";
import { buildFollowupPrompt, buildImplementPrompt } from "../src/git.ts";
import {
  buildPullRequestBody,
  filterCiOnlyRemainingItems,
  isCiOnlyRemainingItem,
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

describe("finished-or-partial comes from the explicit remaining list", () => {
  test("CI-only checks never count as remaining work", () => {
    expect(isCiOnlyRemainingItem("bun run test:pg")).toBe(true);
    expect(isCiOnlyRemainingItem("full bun run ci green")).toBe(true);
    expect(isCiOnlyRemainingItem("Postgres tests pass on the forge")).toBe(true);
    expect(isCiOnlyRemainingItem("backfill the missing test")).toBe(false);
    expect(filterCiOnlyRemainingItems(["bun run test:pg", "backfill x"])).toEqual(["backfill x"]);
    expect(filterCiOnlyRemainingItems(["bun run test:pg", "full bun run ci"])).toEqual([]);
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

  test("words in the prose never keep a body non-closing without an explicit list", () => {
    expect(buildPullRequestBody(12, "Partial work.\n\nRefs #12\n\nRemaining:\n- one more case")).toMatch(/fixes #12/i);
    expect(buildPullRequestBody(12, "Review follow-up: addressed comments.\n\nRefs #12")).toBe(
      "Review follow-up: addressed comments.\n\nFixes #12"
    );
    expect(buildPullRequestBody(12, "Did part.\n\nRefs #12\n\nTODO: backfill test")).toMatch(/fixes #12/i);
  });

  test("an explicit remaining list publishes Refs and shows the item", () => {
    const body = buildPullRequestBody(12, "Did part.\n\nRefs #12", undefined, [], undefined, ["one more case"]);
    expect(body).toContain("Refs #12");
    expect(body).toContain("one more case");
    expect(body).not.toMatch(/fixes #12/i);
  });

  test("an explicit remaining list of only CI checks publishes the closing keyword", () => {
    expect(
      buildPullRequestBody(12, "Did the work.\n\nRefs #12", undefined, [], undefined, [
        "bun run test:pg",
        "full bun run ci",
      ])
    ).toMatch(/fixes #12/i);
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

  test("worker prompts name the explicit remaining list and forge CI", () => {
    for (const prompt of [buildImplementPrompt(), buildFollowupPrompt()]) {
      expect(prompt).toContain("set_pr_body");
      expect(prompt).toContain("Refs #N");
      expect(prompt).toContain("leave the list empty when Done is met");
      expect(prompt).toContain("forge's CI is what counts");
      expect(prompt).toContain("clean default-branch tree");
    }
  });
});
