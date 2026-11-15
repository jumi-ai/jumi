import { describe, expect, test } from "bun:test";
import type { Forge, IssueApi, ReviewApi } from "../../src/ports.ts";
import { makeForgeApi, makeIssueApi, makeReviewApi } from "./forge.ts";

describe("shared forge fakes", () => {
  test("recorder captures method names and args in order", async () => {
    const api = makeForgeApi();
    await api.getRepo("o", "r");
    await api.createIssueComment("o", "r", 12, "hello");
    await api.listOpenPulls("o", "r");
    expect(api.calls.map((call) => call.method)).toEqual(["getRepo", "createIssueComment", "listOpenPulls"]);
    expect(api.calls[1]?.args).toEqual(["o", "r", 12, "hello"]);
    expect(api.callsTo("getRepo")).toHaveLength(1);
    expect(api.callsTo("missing")).toEqual([]);
  });

  test("overrides win over the neutral defaults", async () => {
    const review = makeReviewApi({
      getPRFiles: async () => [
        {
          filename: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
    });
    expect(await review.getPRFiles("o", "r", 7)).toHaveLength(1);
    expect(await review.listCommitStatuses("o", "r", "sha")).toEqual([]);

    const issue = makeIssueApi({ listOpenPulls: async () => [] });
    expect(await issue.listOpenPulls("o", "r")).toEqual([]);
    expect((await issue.getIssue("o", "r", 12)).number).toBe(12);
  });

  test("default objects cover every interface member", () => {
    const forge = makeForgeApi();
    const _forgeComplete: Forge = forge;
    void _forgeComplete;
    const review = makeReviewApi();
    const _reviewComplete: ReviewApi = review;
    void _reviewComplete;
    const issue = makeIssueApi();
    const _issueComplete: IssueApi = issue;
    void _issueComplete;

    const forgeSatisfies: Forge = makeForgeApi() satisfies Forge;
    void forgeSatisfies;
    const reviewSatisfies: ReviewApi = makeReviewApi() satisfies ReviewApi;
    void reviewSatisfies;
    const issueSatisfies: IssueApi = makeIssueApi() satisfies IssueApi;
    void issueSatisfies;

    for (const method of [
      "getRepo",
      "getPR",
      "listOpenPulls",
      "createPullRequest",
      "getPRFiles",
      "createIssueComment",
      "listCommitStatuses",
    ] as const) {
      expect(typeof (forge as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    expect(typeof (review as unknown as Record<string, unknown>)["getIssue"]).toBe("function");
    expect(typeof (issue as unknown as Record<string, unknown>)["getIssue"]).toBe("function");
  });
});
