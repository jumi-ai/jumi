import { afterEach, describe, expect, test } from "bun:test";
import {
  checkRunState,
  GithubAPI,
  toCheckFromCheckRun,
  toGiteaReviewState,
  toGithubReviewEvent,
  toInlineComment,
  toLinkedIssue,
  toPullFile,
  toPullReview,
} from "../src/github_api.ts";
import { GITHUB_API_URL } from "../src/github_auth.ts";
import { makeUser } from "./fixtures.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function api() {
  return new GithubAPI({ token: "token-1" });
}

describe("GithubAPI", () => {
  test("sends bearer auth headers, encodes repo paths, and paginates with per_page", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      methods.push(init?.method ?? "GET");
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer token-1");
      expect((init?.headers as Record<string, string> | undefined)?.Accept).toBe("application/vnd.github+json");
      if (String(url).includes("page=1"))
        return Response.json(Array.from({ length: 50 }, () => ({ filename: "a.ts", status: "modified" })));
      if (String(url).includes("page=2")) return Response.json([]);
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    await api().getPRFiles("owner name", "repo/name", 7);

    expect(methods).toEqual(["GET", "GET"]);
    expect(urls[0]).toContain("/repos/owner%20name/repo%2Fname/pulls/7/files?per_page=50&page=1");
    expect(urls[1]).toContain("&page=2");
    expect(urls[0].startsWith(`${GITHUB_API_URL}/`)).toBe(true);
  });

  test("creates and updates issue comments and commit statuses", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({
        id: 9,
        body: "ok",
        user: { login: "jumi" },
        state: "pending",
        context: "jumi/opencode-review",
      });
    }) as unknown as typeof fetch;

    await api().createIssueComment("owner", "repo", 7, "new body");
    await api().updateIssueComment("owner", "repo", 9, "updated body");
    await api().createCommitStatus("owner", "repo", "sha/1", {
      state: "pending",
      context: "jumi/opencode-review",
      description: "running",
    });

    expect(requests[0]).toEqual({
      url: `${GITHUB_API_URL}/repos/owner/repo/issues/7/comments`,
      method: "POST",
      body: JSON.stringify({ body: "new body" }),
    });
    expect(requests[1]).toEqual({
      url: `${GITHUB_API_URL}/repos/owner/repo/issues/comments/9`,
      method: "PATCH",
      body: JSON.stringify({ body: "updated body" }),
    });
    expect(requests[2]).toEqual({
      url: `${GITHUB_API_URL}/repos/owner/repo/statuses/sha%2F1`,
      method: "POST",
      body: JSON.stringify({ state: "pending", context: "jumi/opencode-review", description: "running" }),
    });

    await api().createCommitStatus("owner", "repo", "sha/1", {
      state: "warning",
      context: "jumi/opencode-review",
      description: "skipped",
    });
    expect(JSON.parse(requests[3]?.body ?? "{}")).toEqual({
      state: "failure",
      context: "jumi/opencode-review",
      description: "skipped",
    });
  });

  test("truncates GitHub status descriptions to 140 characters before the POST", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ state: "failure", context: "jumi/opencode-review" });
    }) as unknown as typeof fetch;

    const exact = "y".repeat(140);
    await api().createCommitStatus("owner", "repo", "sha", {
      state: "failure",
      context: "jumi/opencode-review",
      description: exact,
    });
    expect(JSON.parse(bodies[0] ?? "{}").description).toBe(exact);

    await api().createCommitStatus("owner", "repo", "sha", {
      state: "failure",
      context: "jumi/opencode-review",
      description: "x".repeat(255),
    });
    const ascii = JSON.parse(bodies[1] ?? "{}").description as string;
    expect(Array.from(ascii).length).toBe(140);
    expect(ascii.endsWith("…")).toBe(true);
    expect(ascii).not.toBe("x".repeat(255));

    await api().createCommitStatus("owner", "repo", "sha", {
      state: "failure",
      context: "jumi/opencode-review",
      description: "€".repeat(141),
    });
    const euros = JSON.parse(bodies[2] ?? "{}").description as string;
    expect(Array.from(euros).length).toBe(140);
    expect(euros.endsWith("…")).toBe(true);
    expect(euros.startsWith("€".repeat(100))).toBe(true);
    expect(new TextEncoder().encode(euros).byteLength).toBeGreaterThan(255);

    const stderr = `tool trace ${"z".repeat(400)}`;
    await api().createCommitStatus("owner", "repo", "sha", {
      state: "failure",
      context: "jumi/opencode-review",
      description: `Jumi review failed: opencode exited with code 143:\n${stderr}`,
    });
    const failure = JSON.parse(bodies[3] ?? "{}").description as string;
    expect(failure).not.toContain(stderr);
    expect(failure).not.toContain("tool trace");
    expect(failure).toContain("opencode exited with code 143");
    expect(Array.from(failure).length).toBeLessThanOrEqual(140);
  });

  test("toGithubReviewEvent maps Gitea APPROVED to GitHub APPROVE", () => {
    expect(toGithubReviewEvent("APPROVED")).toBe("APPROVE");
    expect(toGithubReviewEvent("REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
    expect(toGithubReviewEvent("COMMENT")).toBe("COMMENT");
  });

  test("toGiteaReviewState maps GitHub review states onto the Gitea port bag", () => {
    expect(toGiteaReviewState("CHANGES_REQUESTED")).toBe("REQUEST_CHANGES");
    expect(toGiteaReviewState("COMMENTED")).toBe("COMMENT");
    expect(toGiteaReviewState("APPROVED")).toBe("APPROVED");
    expect(toGiteaReviewState("DISMISSED")).toBe("DISMISSED");
  });

  test("toPullReview maps DISMISSED state to dismissed boolean", () => {
    expect(
      toPullReview({
        id: 9,
        state: "DISMISSED",
        user: makeUser({ login: "jumi" }),
      })
    ).toMatchObject({ state: "DISMISSED", dismissed: true });
    expect(toPullReview({ id: 10, state: "CHANGES_REQUESTED", user: makeUser({ login: "jumi" }) })).toMatchObject({
      state: "REQUEST_CHANGES",
      dismissed: false,
    });
    expect(toPullReview({ id: 11, state: "COMMENTED", user: makeUser({ login: "jumi" }) }).state).toBe("COMMENT");
  });

  test("toInlineComment prefers line then original_line then position", () => {
    const base = {
      id: 1,
      body: "a",
      user: makeUser({ login: "jumi" }),
      created_at: "",
      updated_at: "",
      path: "src/foo.ts",
    };
    expect(toInlineComment({ ...base, line: 9, original_line: 8, position: 7 }).new_position).toBe(9);
    expect(toInlineComment({ ...base, original_line: 8, position: 7 }).new_position).toBe(8);
    expect(toInlineComment({ ...base, position: 7 }).new_position).toBe(7);
    expect(toInlineComment(base).resolved).toBe(false);
    expect(toInlineComment(base, true).resolved).toBe(true);
    expect(toInlineComment(base, true).resolver).toBeUndefined();
    expect(toInlineComment(base, true, "alice").resolver).toEqual({ login: "alice" });
  });

  test("toPullFile maps GitHub removed to deleted", () => {
    expect(toPullFile({ filename: "gone.ts", status: "removed", additions: 0, deletions: 3, changes: 3 }).status).toBe(
      "deleted"
    );
  });

  test("creates a pull review mapping APPROVED to APPROVE and new_position to line", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (href.includes("/graphql")) return Response.json({ data: { viewer: { login: "jumi[bot]" } } });
      if (href.includes("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 7,
          title: "Add feature",
          body: "PR body",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "alice" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
          base: { ref: "main", sha: "def" },
          merged: false,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    await api().createPullReview("owner", "repo", 7, {
      commit_id: "abc",
      event: "APPROVED",
      comments: [{ path: "src/foo.ts", new_position: 12, body: "bug" }],
    });
    const review = requests.find((req) => req.url.endsWith("/pulls/7/reviews") && req.method === "POST");
    expect(review?.body).toBe(
      JSON.stringify({
        commit_id: "abc",
        event: "APPROVE",
        comments: [{ path: "src/foo.ts", body: "bug", line: 12 }],
      })
    );
  });

  test("forces COMMENT on self-authored PRs", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (href.includes("/graphql")) return Response.json({ data: { viewer: { login: "jumi[bot]" } } });
      if (href.includes("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 7,
          title: "Self",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "jumi[bot]" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
          base: { ref: "main", sha: "def" },
          merged: false,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    await api().createPullReview("owner", "repo", 7, { commit_id: "abc", event: "APPROVED" });
    const review = requests.find((req) => req.url.endsWith("/pulls/7/reviews") && req.method === "POST");
    expect(review?.body).toBe(JSON.stringify({ commit_id: "abc", body: "", event: "COMMENT" }));
  });

  test("defaults empty body for COMMENT and REQUEST_CHANGES", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (href.includes("/graphql")) return Response.json({ data: { viewer: { login: "jumi[bot]" } } });
      if (href.includes("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 7,
          title: "Add feature",
          body: "PR body",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "alice" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
          base: { ref: "main", sha: "def" },
          merged: false,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    await api().createPullReview("owner", "repo", 7, { commit_id: "abc", event: "COMMENT" });
    await api().createPullReview("owner", "repo", 7, {
      commit_id: "abc",
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/foo.ts", new_position: 12, body: "bug" }],
    });
    const posts = requests.filter((req) => req.url.endsWith("/pulls/7/reviews") && req.method === "POST");
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({ commit_id: "abc", body: "", event: "COMMENT" });
    expect(JSON.parse(posts[1]?.body ?? "{}")).toEqual({
      commit_id: "abc",
      body: "",
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/foo.ts", body: "bug", line: 12 }],
    });
  });

  test("remaps to COMMENT when viewer login is missing", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (href.includes("/graphql")) return Response.json({ data: { viewer: {} } });
      if (href.includes("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 7,
          title: "Self",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "jumi[bot]" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
          base: { ref: "main", sha: "def" },
          merged: false,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    await api().createPullReview("owner", "repo", 7, { commit_id: "abc", event: "APPROVED", body: "lgtm" });
    const review = requests.find((req) => req.url.endsWith("/pulls/7/reviews") && req.method === "POST");
    expect(review?.body).toBe(JSON.stringify({ commit_id: "abc", body: "lgtm", event: "COMMENT" }));
  });

  test("does not post APPROVE when viewer GraphQL fails", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (href.includes("/graphql")) return Response.json({ errors: [{ message: "unavailable" }] });
      if (href.includes("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return Response.json({
          number: 7,
          title: "Self",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "jumi[bot]" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
          base: { ref: "main", sha: "def" },
          merged: false,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    await expect(api().createPullReview("owner", "repo", 7, { commit_id: "abc", event: "APPROVED" })).rejects.toThrow(
      /unavailable/
    );
    expect(requests.some((req) => req.url.endsWith("/pulls/7/reviews") && req.method === "POST")).toBe(false);
  });

  test("submits a pending pull review as COMMENT", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 99 });
    }) as unknown as typeof fetch;

    await api().submitPullReview("owner", "repo", 7, 99);
    expect(requests[0]).toEqual({
      url: `${GITHUB_API_URL}/repos/owner/repo/pulls/7/reviews/99/events`,
      method: "POST",
      body: JSON.stringify({ event: "COMMENT" }),
    });
  });

  test("resolves and unresolves via GraphQL thread id, not REST comment id", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      const body = init?.body as string | undefined;
      requests.push({ url: href, method: init?.method ?? "GET", body });
      if (href.includes("/pulls/comments/11")) {
        return Response.json({
          id: 11,
          pull_request_url: `${GITHUB_API_URL}/repos/owner/repo/pulls/7`,
        });
      }
      if (href.endsWith("/graphql") && body?.includes("reviewThreads")) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ id: "PRRT_kwDOthread", comments: { nodes: [{ databaseId: 11 }] } }],
                },
              },
            },
          },
        });
      }
      if (href.endsWith("/graphql"))
        return Response.json({ data: { resolveReviewThread: {}, unresolveReviewThread: {} } });
      return Response.json({ id: 9 });
    }) as unknown as typeof fetch;

    await api().resolvePullComment("owner", "repo", 11);
    await api().unresolvePullComment("owner", "repo", 11);
    await api().dismissPullReview("owner", "repo", 7, 9);

    const mutations = requests.filter((req) => req.url.endsWith("/graphql") && req.body?.includes("mutation"));
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.body).toContain("resolveReviewThread");
    expect(mutations[1]?.body).toContain("unresolveReviewThread");
    for (const mutation of mutations) {
      expect(JSON.parse(mutation.body ?? "{}").variables).toEqual({ id: "PRRT_kwDOthread" });
      expect(JSON.parse(mutation.body ?? "{}").variables.id).not.toBe(11);
    }
    expect(requests.some((req) => req.url.includes("/pulls/comments/11/resolve"))).toBe(false);
    expect(requests.at(-1)).toEqual({
      url: `${GITHUB_API_URL}/repos/owner/repo/pulls/7/reviews/9/dismissals`,
      method: "PUT",
      body: JSON.stringify({ message: "superseded" }),
    });
  });

  test("closes a pull request with state closed", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({
        number: 127,
        title: "Fix",
        body: "Fixes #12",
        state: "closed",
        html_url: "https://github.com/owner/repo/pull/127",
        user: { login: "jumi" },
        head: { ref: "jumi/issue-12-fix", sha: "abc", repo: { full_name: "owner/repo" } },
        base: { ref: "main", sha: "def" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const pull = await api().closePullRequest("owner", "repo", 127);
    expect(pull.state).toBe("closed");
    expect(pull.merged).toBe(false);
    expect(requests).toEqual([
      {
        url: `${GITHUB_API_URL}/repos/owner/repo/pulls/127`,
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      },
    ]);
  });

  test("updates only the pull request body", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({
        number: 127,
        title: "Fix",
        body: "new body",
        state: "open",
        html_url: "https://github.com/owner/repo/pull/127",
        user: { login: "jumi" },
        head: { ref: "jumi/issue-12-fix", sha: "abc", repo: { full_name: "owner/repo" } },
        base: { ref: "main", sha: "def" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const pull = await api().updatePullRequestBody("owner", "repo", 127, "new body");
    expect(pull.body).toBe("new body");
    expect(requests).toEqual([
      {
        url: `${GITHUB_API_URL}/repos/owner/repo/pulls/127`,
        method: "PATCH",
        body: JSON.stringify({ body: "new body" }),
      },
    ]);
  });

  test("findStickyIssueComment returns only the matching id", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([
        { id: 1, body: "noise", user: { login: "tapio" } },
        { id: 2, body: "<!-- jumi-review:owner/repo#7 -->\nold", user: { login: "jumi" } },
        { id: 3, body: "more", user: { login: "someone" } },
      ]);
    }) as unknown as typeof fetch;

    await expect(
      api().findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toEqual({ id: 2 });
    expect(urls[0]).toContain("/issues/7/comments?per_page=50&page=1");
  });

  test("findStickyIssueComment returns undefined when sticky is missing", async () => {
    globalThis.fetch = (async () =>
      Response.json([{ id: 1, body: "noise", user: { login: "tapio" } }])) as unknown as typeof fetch;
    await expect(
      api().findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toBeUndefined();
  });

  test("findStickyIssueComment matches the bot login case-insensitively", async () => {
    globalThis.fetch = (async () =>
      Response.json([
        { id: 1, body: "<!-- jumi-review:owner/repo#7 -->\nforeign", user: { login: "tapio" } },
        { id: 2, body: "<!-- jumi-review:owner/repo#7 -->\nold", user: { login: "Jumi" } },
      ])) as unknown as typeof fetch;
    await expect(
      api().findStickyIssueComment("owner", "repo", 7, "JUMI", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toEqual({ id: 2 });
  });

  test("lists issue comments with exact-50 paging", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("page=1")) {
        return Response.json(Array.from({ length: 50 }, (_, i) => ({ id: i, body: "c" })));
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    await api().listIssueComments("owner", "repo", 7);

    expect(urls[0]).toContain("/issues/7/comments?per_page=50&page=1");
    expect(urls[1]).toContain("/issues/7/comments?per_page=50&page=2");
  });

  test("lists issue dependencies and blocks with paging and cross-repo rows", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("/dependencies/blocked_by")) {
        return Response.json([
          {
            number: 196,
            title: "one",
            body: "",
            state: "open",
            html_url: "https://github.com/owner/other/issues/196",
            repository_url: "https://api.github.com/repos/owner/other",
            user: { login: "alice" },
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
          },
        ]);
      }
      if (String(url).includes("/dependencies/blocking")) {
        return Response.json([
          {
            number: 206,
            title: "two",
            body: "",
            state: "open",
            html_url: "https://github.com/owner/repo/issues/206",
            user: { login: "alice" },
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
          },
        ]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const deps = await api().listIssueDependencies("owner", "repo", 206);
    const blocks = await api().listIssueBlocks("owner", "repo", 196);
    expect(deps).toEqual([expect.objectContaining({ owner: "owner", repo: "other", number: 196, state: "open" })]);
    expect(blocks).toEqual([expect.objectContaining({ owner: "owner", repo: "repo", number: 206 })]);
    expect(urls[0]).toContain("/issues/206/dependencies/blocked_by?per_page=50&page=1");
    expect(urls[1]).toContain("/issues/196/dependencies/blocking?per_page=50&page=1");
  });

  test("toLinkedIssue reads owner/repo from repository_url or html_url when nested repository is absent", () => {
    const issue = {
      number: 196,
      title: "one",
      body: "",
      state: "open" as const,
      html_url: "https://github.com/owner/other/issues/196",
      user: { login: "alice" },
      updated_at: "2026-05-23T00:00:00Z",
      created_at: "2026-05-23T00:00:00Z",
    };
    expect(
      toLinkedIssue({ ...issue, repository_url: "https://api.github.com/repos/owner/other" }, "owner", "repo")
    ).toEqual(expect.objectContaining({ owner: "owner", repo: "other", number: 196 }));
    expect(toLinkedIssue({ ...issue, html_url: "https://github.com/owner/other/pull/196" }, "owner", "repo")).toEqual(
      expect.objectContaining({ owner: "owner", repo: "other", number: 196 })
    );
    expect(toLinkedIssue({ ...issue, html_url: "https://github.com/owner/repo/issues/196" }, "owner", "repo")).toEqual(
      expect.objectContaining({ owner: "owner", repo: "repo", number: 196 })
    );
  });

  test("treats 404 on issue dependencies and blocks as an empty list", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(api().listIssueDependencies("owner", "repo", 206)).resolves.toEqual([]);
    await expect(api().listIssueBlocks("owner", "repo", 196)).resolves.toEqual([]);
  });

  test("lists one page of repo issues with assignee", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([
        {
          number: 196,
          title: "one",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/issues/196",
          user: { login: "alice" },
          assignee: { login: "jumi" },
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        },
        {
          number: 7,
          title: "pr",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/pull/7",
          user: { login: "alice" },
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
          pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" },
        },
      ]);
    }) as unknown as typeof fetch;
    const issues = await api().listRepoIssues("owner", "repo", { state: "open", type: "issues", assignedBy: "jumi" });
    expect(issues).toEqual([expect.objectContaining({ owner: "owner", repo: "repo", number: 196 })]);
    expect(urls[0]).toContain("/issues?state=open&assignee=jumi&per_page=50&page=1");
  });

  test("pages past assigned PRs until issue rows fill the cap", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("page=1")) {
        return Response.json(
          Array.from({ length: 50 }, (_, i) => ({
            number: i + 1,
            title: "pr",
            body: "",
            state: "open",
            html_url: `https://github.com/owner/repo/pull/${i + 1}`,
            user: { login: "alice" },
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
            pull_request: { url: `https://api.github.com/repos/owner/repo/pulls/${i + 1}` },
          }))
        );
      }
      return Response.json([
        {
          number: 196,
          title: "one",
          body: "",
          state: "open",
          html_url: "https://github.com/owner/repo/issues/196",
          user: { login: "alice" },
          assignee: { login: "jumi" },
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        },
      ]);
    }) as unknown as typeof fetch;
    const issues = await api().listRepoIssues("owner", "repo", { state: "open", type: "issues", assignedBy: "jumi" });
    expect(issues).toEqual([expect.objectContaining({ owner: "owner", repo: "repo", number: 196 })]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("&page=2");
  });

  test("creates an issue dependency using the target issue global id", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (String(url).includes("/issues/196")) return Response.json({ id: 555001, number: 196 }, { status: 200 });
      return Response.json({ number: 12 }, { status: 201 });
    }) as unknown as typeof fetch;
    await api().createIssueDependency("owner", "repo", 12, { owner: "owner", repo: "repo", number: 196 });
    expect(requests).toEqual([
      {
        url: `${GITHUB_API_URL}/repos/owner/repo/issues/196`,
        method: "GET",
        body: undefined,
      },
      {
        url: `${GITHUB_API_URL}/repos/owner/repo/issues/12/dependencies/blocked_by`,
        method: "POST",
        body: JSON.stringify({ issue_id: 555001 }),
      },
    ]);
  });

  test("lists pull reviews with exact-50 paging", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("page=1")) {
        return Response.json(Array.from({ length: 50 }, (_, i) => ({ id: i })));
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    await api().listPullReviews("owner", "repo", 7);

    expect(urls[0]).toContain("/pulls/7/reviews?per_page=50&page=1");
    expect(urls[1]).toContain("/pulls/7/reviews?per_page=50&page=2");
  });

  test("listPullReviewComments uses REST /pulls/{index}/comments", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.endsWith("/graphql")) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      id: "PRRT_resolved",
                      isResolved: true,
                      resolvedBy: { login: "alice" },
                      comments: { nodes: [{ databaseId: 101 }] },
                    },
                    { id: "PRRT_open", isResolved: false, comments: { nodes: [{ databaseId: 102 }] } },
                  ],
                },
              },
            },
          },
        });
      }
      return Response.json([
        { id: 101, body: "a", path: "src/foo.ts", line: 12, commit_id: "oldsha", pull_request_review_id: 9 },
        {
          id: 102,
          body: "b",
          path: "src/bar.ts",
          original_line: 40,
          position: 3,
          commit_id: "headsha",
          pull_request_review_id: 10,
        },
      ]);
    }) as unknown as typeof fetch;

    const comments = await api().listPullReviewComments("owner", "repo", 7);
    expect(comments.map((comment) => comment.id)).toEqual([101, 102]);
    expect(comments.map((comment) => comment.new_position)).toEqual([12, 40]);
    expect(comments.map((comment) => comment.commit_id)).toEqual(["oldsha", "headsha"]);
    expect(comments.map((comment) => comment.pull_request_review_id)).toEqual([9, 10]);
    expect(comments.map((comment) => comment.resolved)).toEqual([true, false]);
    expect(comments.map((comment) => comment.resolver?.login)).toEqual(["alice", undefined]);
    expect(urls[0]).toBe(`${GITHUB_API_URL}/repos/owner/repo/pulls/7/comments?per_page=50&page=1`);
    expect(urls[1]).toBe(`${GITHUB_API_URL}/graphql`);
  });

  test("lists commit statuses and flattens action jobs from recent runs; logs follow 302", async () => {
    const urls: string[] = [];
    const authed: boolean[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      urls.push(href);
      authed.push(Boolean((init?.headers as Record<string, string> | undefined)?.Authorization));
      if (new URL(href).hostname === "pipelines.actions.githubusercontent.com") {
        return new Response("##[error]boom\n", { status: 200 });
      }
      if (href.includes("/actions/jobs/9/logs")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://pipelines.actions.githubusercontent.com/signed?exp=1" },
        });
      }
      if (href.includes("/actions/runs/") && href.includes("/jobs")) {
        return Response.json({
          jobs: [{ id: 9, name: "build", status: "completed", conclusion: "failure", run_id: 44 }],
        });
      }
      if (href.includes("/actions/runs")) {
        return Response.json({ workflow_runs: [{ id: 44, head_branch: "main" }], total_count: 1 });
      }
      if (href.includes("/commits/") && href.includes("/statuses")) {
        return Response.json([{ id: 1, context: "build", state: "failure" }]);
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(api().listCommitStatuses("owner", "repo", "sha/1")).resolves.toEqual([
      { id: 1, context: "build", state: "failure", status: "failure" },
    ]);
    await expect(api().listActionJobs("owner", "repo", { status: "failure" })).resolves.toEqual([
      { id: 9, name: "build", status: "completed", conclusion: "failure", head_branch: "main", run_id: 44 },
    ]);
    await expect(api().getActionJobLogs("owner", "repo", 9)).resolves.toBe("##[error]boom\n");
    expect(urls[0]).toContain("/commits/sha%2F1/statuses");
    expect(urls[1]).toContain("/actions/runs?per_page=50&page=1&status=failure");
    expect(urls[2]).toContain("/actions/runs/44/jobs?per_page=100");
    expect(urls[3]).toContain("/actions/jobs/9/logs");
    expect(urls[4]).toContain("pipelines.actions.githubusercontent.com/signed");
    expect(authed[3]).toBe(true);
    expect(authed[4]).toBe(false);
  });

  test("scopes workflow runs to head_sha when listing action jobs", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("/actions/runs/") && String(url).includes("/jobs")) {
        return Response.json({ jobs: [{ id: 9, name: "build", status: "in_progress", run_id: 44 }] });
      }
      if (String(url).includes("/actions/runs")) {
        return Response.json({ workflow_runs: [{ id: 44, head_branch: "main" }], total_count: 1 });
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(api().listActionJobs("owner", "repo", { headSha: "abc/def" })).resolves.toEqual([
      { id: 9, name: "build", status: "in_progress", head_branch: "main", run_id: 44 },
    ]);
    expect(urls[0]).toContain("/actions/runs?per_page=50&page=1&head_sha=abc%2Fdef");
  });

  test("a disabled Actions unit is an empty job list, not an error", async () => {
    for (const status of [403, 404]) {
      globalThis.fetch = (async () => new Response("unit disabled", { status })) as unknown as typeof fetch;
      await expect(api().listActionJobs("owner", "repo")).resolves.toEqual([]);
    }
  });

  test("an Actions list that might hide a job still throws", async () => {
    globalThis.fetch = (async () =>
      new Response("API rate limit exceeded", { status: 403 })) as unknown as typeof fetch;
    await expect(api().listActionJobs("owner", "repo")).rejects.toThrow("403");
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(api().listActionJobs("owner", "repo")).rejects.toThrow("500");
  });

  test("lists check-runs for a SHA and maps conclusions", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("/check-runs")) {
        return Response.json({
          total_count: 2,
          check_runs: [
            {
              id: 4,
              name: "checks",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/owner/repo/actions/runs/9/job/4",
              output: { title: "Process completed with exit code 1." },
            },
            {
              id: 5,
              name: "image",
              status: "completed",
              conclusion: "skipped",
              html_url: "https://github.com/owner/repo/actions/runs/9/job/5",
            },
          ],
        });
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(api().listCheckRuns("owner", "repo", "sha/1")).resolves.toEqual([
      {
        id: 4,
        context: "checks",
        state: "failure",
        status: "failure",
        description: "Process completed with exit code 1.",
        target_url: "https://github.com/owner/repo/actions/runs/9/job/4",
        created_at: undefined,
        updated_at: undefined,
        url: "https://github.com/owner/repo/actions/runs/9/job/4",
        jobId: 4,
      },
      {
        id: 5,
        context: "image",
        state: "success",
        status: "success",
        description: "skipped",
        target_url: "https://github.com/owner/repo/actions/runs/9/job/5",
        created_at: undefined,
        updated_at: undefined,
        url: "https://github.com/owner/repo/actions/runs/9/job/5",
        jobId: 5,
      },
    ]);
    expect(urls[0]).toContain("/commits/sha%2F1/check-runs?filter=latest&per_page=50&page=1");
  });

  test("falls back to Actions jobs by head SHA when check-runs are forbidden", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/check-runs")) return new Response("nope", { status: 403 });
      if (href.includes("/actions/runs/") && href.includes("/jobs")) {
        return Response.json({
          jobs: [
            { id: 4, name: "checks", status: "completed", conclusion: "failure" },
            { id: 5, name: "image", status: "completed", conclusion: "skipped" },
          ],
        });
      }
      if (href.includes("/actions/runs")) {
        return Response.json({ workflow_runs: [{ id: 9, head_sha: "sha/1" }], total_count: 1 });
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(api().listCheckRuns("owner", "repo", "sha/1")).resolves.toEqual([
      {
        id: 4,
        context: "checks",
        state: "failure",
        status: "failure",
        description: "failure",
        target_url: undefined,
        jobId: 4,
      },
      {
        id: 5,
        context: "image",
        state: "success",
        status: "success",
        description: "skipped",
        target_url: undefined,
        jobId: 5,
      },
    ]);
    expect(urls[0]).toContain("/check-runs");
    expect(urls[1]).toContain("/actions/runs?head_sha=sha%2F1");
    expect(urls[2]).toContain("/actions/runs/9/jobs");
  });

  test("throws useful errors for non-2xx responses", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(api().getPR("owner", "repo", 1)).rejects.toThrow("500: nope");
  });

  test("maps GitHub JSON to host-agnostic Task and Pull refs", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/issues/12")) {
        return Response.json({
          id: 200,
          number: 12,
          title: "Fix the thing",
          body: "Please implement this.",
          state: "open",
          html_url: "https://github.com/owner/repo/issues/12",
          user: { id: 1, login: "alice", avatar_url: "https://x" },
          assignee: { login: "jumi" },
          assignees: [{ login: "jumi" }],
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({
        id: 100,
        number: 7,
        title: "Add feature",
        body: "PR body",
        state: "open",
        html_url: "https://github.com/owner/repo/pull/7",
        user: { login: "alice" },
        head: {
          label: "alice:feature",
          ref: "feature",
          sha: "abc123",
          repo: { full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git" },
        },
        base: { ref: "main", sha: "def456" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const task = await api().getIssue("owner", "repo", 12);
    expect(task).toEqual({
      trackerRef: "12",
      number: 12,
      title: "Fix the thing",
      body: "Please implement this.",
      state: "open",
      html_url: "https://github.com/owner/repo/issues/12",
      user: { login: "alice" },
      assignee: { login: "jumi" },
      assignees: [{ login: "jumi" }],
      updated_at: "2026-05-23T00:00:00Z",
      created_at: "2026-05-23T00:00:00Z",
      is_pull: false,
    });
    expect("avatar_url" in task.user).toBe(false);

    const pull = await api().getPR("owner", "repo", 7);
    expect(pull.forgeRef).toBe("7");
    expect(pull.number).toBe(7);
    expect(pull.head).toEqual({
      ref: "feature",
      sha: "abc123",
      repo: { full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git" },
    });
    expect("label" in pull.head).toBe(false);
  });

  test("uses GithubAppAuth token source when provided", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer ghs_from_auth");
      return Response.json({
        name: "repo",
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
        clone_url: "https://github.com/owner/repo.git",
        default_branch: "main",
        owner: { login: "owner" },
      });
    }) as unknown as typeof fetch;

    const client = new GithubAPI({
      auth: { getInstallationToken: async () => "ghs_from_auth" },
    });
    const repo = await client.getRepo("owner", "repo");
    expect(repo.full_name).toBe("owner/repo");
    expect(urls[0]).toBe(`${GITHUB_API_URL}/repos/owner/repo`);
  });

  test("REST and git credentials request the token for that owner/repo", async () => {
    const targets: unknown[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/graphql")) {
        return Response.json({ data: { viewer: { login: "kirmanak-jumi[bot]", databaseId: 7 } } });
      }
      return Response.json({
        name: "jumi",
        full_name: "kirmanak/jumi",
        html_url: "https://github.com/kirmanak/jumi",
        clone_url: "https://github.com/kirmanak/jumi.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
      });
    }) as unknown as typeof fetch;

    const client = new GithubAPI({
      auth: {
        getInstallationToken: async (target) => {
          targets.push(target);
          return "ghs_from_auth";
        },
        refreshInstallationToken: async (target) => {
          targets.push({ refresh: true, ...target });
          return "ghs_fresh";
        },
      },
    });
    await client.getRepo("kirmanak", "jumi");
    const creds = await client.resolveGitCredentials({ owner: "kirmanak", repo: "jumi" });
    expect(targets).toEqual([
      { owner: "kirmanak", repo: "jumi" },
      { refresh: true, owner: "kirmanak", repo: "jumi" },
      { owner: "kirmanak", repo: "jumi" },
    ]);
    expect(creds.token).toBe("ghs_fresh");
  });

  test("gitIdentity uses viewer login and databaseId for the noreply email", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        expect(body.query).toContain("databaseId");
        return Response.json({ data: { viewer: { login: "kirmanak-jumi[bot]", databaseId: 198765 } } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const identity = await api().gitIdentity();
    expect(identity).toEqual({
      name: "kirmanak-jumi[bot]",
      email: "198765+kirmanak-jumi[bot]@users.noreply.github.com",
    });
  });

  test("resolveGitCredentials refreshes the installation token and embeds x-access-token", async () => {
    let refreshes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/graphql")) {
        return Response.json({ data: { viewer: { login: "kirmanak-jumi[bot]", databaseId: 42 } } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const client = new GithubAPI({
      auth: {
        getInstallationToken: async () => "ghs_cached",
        refreshInstallationToken: async () => {
          refreshes += 1;
          return "ghs_fresh";
        },
      },
    });
    const creds = await client.resolveGitCredentials();
    expect(refreshes).toBe(1);
    expect(creds).toEqual({
      username: "x-access-token",
      token: "ghs_fresh",
      embedTokenInUrl: true,
      authorName: "kirmanak-jumi[bot]",
      authorEmail: "42+kirmanak-jumi[bot]@users.noreply.github.com",
    });
  });

  test("gets collaborator permission for write gating", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json({ permission: "write", role_name: "write", user: { login: "alice" } });
    }) as unknown as typeof fetch;

    const client = new GithubAPI({ token: "ghs_test" });
    const info = await client.getCollaboratorPermission("owner", "repo", "alice");

    expect(info.permission).toBe("write");
    expect(urls[0]).toContain("/repos/owner/repo/collaborators/alice/permission");
  });
});

describe("checkRunState", () => {
  test("maps GitHub Actions conclusions", () => {
    expect(checkRunState("in_progress", null)).toBe("pending");
    expect(checkRunState("queued", null)).toBe("pending");
    expect(checkRunState("completed", "failure")).toBe("failure");
    expect(checkRunState("completed", "timed_out")).toBe("failure");
    expect(checkRunState("completed", "startup_failure")).toBe("failure");
    expect(checkRunState("completed", "action_required")).toBe("pending");
    expect(checkRunState("completed", "skipped")).toBe("success");
    expect(checkRunState("completed", "success")).toBe("success");
    expect(checkRunState("completed", "cancelled")).toBe("success");
    expect(toCheckFromCheckRun({ id: 4, name: "checks", status: "completed", conclusion: "failure" })).toMatchObject({
      context: "checks",
      status: "failure",
      jobId: 4,
    });
  });
});
