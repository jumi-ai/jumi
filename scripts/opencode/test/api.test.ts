import { afterEach, describe, expect, test } from "bun:test";
import { GiteaAPI, toInlineComment, toPullReview } from "../src/api.ts";
import { stickyFailureDetail } from "../src/sticky_failure.ts";
import { makeUser } from "./fixtures.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GiteaAPI", () => {
  test("sends auth headers, encodes repo paths, and paginates", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      methods.push(init?.method ?? "GET");
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("token token-1");
      if (String(url).includes("page=1"))
        return Response.json(Array.from({ length: 50 }, () => ({ filename: "a.ts" })));
      if (String(url).includes("page=2")) return Response.json([]);
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test/", "token-1");
    await api.getPRFiles("owner name", "repo/name", 7);

    expect(methods).toEqual(["GET", "GET"]);
    expect(urls[0]).toContain("/repos/owner%20name/repo%2Fname/pulls/7/files?limit=50&page=1");
    expect(urls[1]).toContain("&page=2");
  });

  test("creates and updates issue comments", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 9, body: "ok", user: { login: "jumi" } });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.createIssueComment("owner", "repo", 7, "new body");
    await api.updateIssueComment("owner", "repo", 9, "updated body");
    await api.createCommitStatus("owner", "repo", "sha/1", {
      state: "pending",
      context: "jumi/opencode-review",
      description: "running",
    });

    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/issues/7/comments",
      method: "POST",
      body: JSON.stringify({ body: "new body" }),
    });
    expect(requests[1]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/issues/comments/9",
      method: "PATCH",
      body: JSON.stringify({ body: "updated body" }),
    });
    expect(requests[2]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/statuses/sha%2F1",
      method: "POST",
      body: JSON.stringify({ state: "pending", context: "jumi/opencode-review", description: "running" }),
    });
  });

  test("toPullReview maps the parent review commit_id", () => {
    expect(
      toPullReview({
        id: 9,
        commit_id: "headsha",
        state: "COMMENT",
        user: makeUser({ login: "jumi" }),
      }).commit_id
    ).toBe("headsha");
  });

  test("toPullReview maps Gitea's dismissed boolean while state stays REQUEST_CHANGES", () => {
    expect(
      toPullReview({
        id: 9,
        state: "REQUEST_CHANGES",
        dismissed: true,
        user: makeUser({ login: "jumi" }),
      })
    ).toMatchObject({ state: "REQUEST_CHANGES", dismissed: true });
    expect(
      toPullReview({
        id: 10,
        state: "REQUEST_CHANGES",
        user: makeUser({ login: "jumi" }),
      }).dismissed
    ).toBe(false);
  });

  test("toInlineComment prefers new_position then line then position", () => {
    const base = {
      id: 1,
      body: "a",
      user: makeUser({ login: "jumi" }),
      created_at: "",
      updated_at: "",
      path: "src/foo.ts",
    };
    expect(toInlineComment({ ...base, new_position: 9, line: 8, position: 7 }).new_position).toBe(9);
    expect(toInlineComment({ ...base, line: 8, position: 7 }).new_position).toBe(8);
    expect(toInlineComment({ ...base, position: 7 }).new_position).toBe(7);
    expect(toInlineComment({ ...base, resolver: makeUser({ login: "jumi" }) }).resolved).toBe(true);
    expect(toInlineComment({ ...base, resolved: true }).resolved).toBe(true);
    expect(toInlineComment(base).resolved).toBe(false);
  });

  test("creates a pull review with inline comments", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 3 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.createPullReview("owner", "repo", 7, {
      commit_id: "abc",
      event: "COMMENT",
      comments: [{ path: "src/foo.ts", new_position: 12, body: "🔴 bug: null deref." }],
    });
    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews",
      method: "POST",
      body: JSON.stringify({
        commit_id: "abc",
        event: "COMMENT",
        comments: [{ path: "src/foo.ts", new_position: 12, body: "🔴 bug: null deref." }],
      }),
    });
  });

  test("submits a pending pull review as COMMENT", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 99 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.submitPullReview("owner", "repo", 7, 99);
    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews/99",
      method: "POST",
      body: JSON.stringify({ event: "COMMENT" }),
    });
  });

  test("submits a pending pull review with a body marker", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 99 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.submitPullReview("owner", "repo", 7, 99, "<!-- jumi-review:owner/repo#7 -->");
    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews/99",
      method: "POST",
      body: JSON.stringify({ body: "<!-- jumi-review:owner/repo#7 -->", event: "COMMENT" }),
    });
  });

  test("resolves, unresolves, and dismisses pull review comments", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 9 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.resolvePullComment("owner", "repo", 11);
    await api.unresolvePullComment("owner", "repo", 11);
    await api.dismissPullReview("owner", "repo", 7, 9);
    expect(requests).toEqual([
      {
        url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/comments/11/resolve",
        method: "POST",
        body: JSON.stringify({}),
      },
      {
        url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/comments/11/unresolve",
        method: "POST",
        body: JSON.stringify({}),
      },
      {
        url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews/9/dismissals",
        method: "POST",
        body: JSON.stringify({ message: "superseded", priors: false }),
      },
    ]);
  });

  test("closes a pull request with state closed", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({
        id: 100,
        number: 127,
        title: "Fix",
        body: "Fixes #12",
        state: "closed",
        html_url: "https://gitea.example.test/owner/repo/pulls/127",
        user: { login: "jumi" },
        head: { ref: "jumi/issue-12-fix", sha: "abc", repo: { full_name: "owner/repo" }, repo_id: 10 },
        base: { ref: "main", sha: "def" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const pull = await api.closePullRequest("owner", "repo", 127);
    expect(pull.state).toBe("closed");
    expect(pull.merged).toBe(false);
    expect(requests).toEqual([
      {
        url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/127",
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
        id: 100,
        number: 127,
        title: "Fix",
        body: "new body",
        state: "open",
        html_url: "https://gitea.example.test/owner/repo/pulls/127",
        user: { login: "jumi" },
        head: { ref: "jumi/issue-12-fix", sha: "abc", repo: { full_name: "owner/repo" }, repo_id: 10 },
        base: { ref: "main", sha: "def" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const pull = await api.updatePullRequestBody("owner", "repo", 127, "new body");
    expect(pull.body).toBe("new body");
    expect(requests).toEqual([
      {
        url: "https://gitea.example.test/api/v1/repos/owner/repo/pulls/127",
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

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(
      api.findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toEqual({ id: 2 });
    expect(urls[0]).toContain("/issues/7/comments?limit=50&page=1");
  });

  test("findStickyIssueComment returns undefined when sticky is missing", async () => {
    globalThis.fetch = (async () =>
      Response.json([{ id: 1, body: "noise", user: { login: "tapio" } }])) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(
      api.findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toBeUndefined();
  });

  test("findStickyIssueComment matches the bot login case-insensitively", async () => {
    globalThis.fetch = (async () =>
      Response.json([
        { id: 1, body: "<!-- jumi-review:owner/repo#7 -->\nforeign", user: { login: "tapio" } },
        { id: 2, body: "<!-- jumi-review:owner/repo#7 -->\nold", user: { login: "Jumi" } },
      ])) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(
      api.findStickyIssueComment("owner", "repo", 7, "JUMI", "<!-- jumi-review:owner/repo#7 -->")
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

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.listIssueComments("owner", "repo", 7);

    expect(urls[0]).toContain("/issues/7/comments?limit=50&page=1");
    expect(urls[1]).toContain("/issues/7/comments?limit=50&page=2");
  });

  test("lists issue dependencies and blocks with paging and cross-repo rows", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("/dependencies")) {
        return Response.json([
          {
            number: 196,
            title: "one",
            body: "",
            state: "open",
            html_url: "https://gitea.example.test/owner/repo/issues/196",
            user: { login: "alice" },
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
            repository: { full_name: "owner/other", name: "other", owner: "owner" },
          },
        ]);
      }
      if (String(url).includes("/blocks")) {
        return Response.json([
          {
            number: 206,
            title: "two",
            body: "",
            state: "open",
            html_url: "https://gitea.example.test/owner/repo/issues/206",
            user: { login: "alice" },
            updated_at: "2026-05-23T00:00:00Z",
            created_at: "2026-05-23T00:00:00Z",
          },
        ]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const deps = await api.listIssueDependencies("owner", "repo", 206);
    const blocks = await api.listIssueBlocks("owner", "repo", 196);
    expect(deps).toEqual([expect.objectContaining({ owner: "owner", repo: "other", number: 196, state: "open" })]);
    expect(blocks).toEqual([expect.objectContaining({ owner: "owner", repo: "repo", number: 206 })]);
    expect(urls[0]).toContain("/issues/206/dependencies?limit=50&page=1");
    expect(urls[1]).toContain("/issues/196/blocks?limit=50&page=1");
  });

  test("treats 404 on issue dependencies and blocks as an empty list", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listIssueDependencies("owner", "repo", 206)).resolves.toEqual([]);
    await expect(api.listIssueBlocks("owner", "repo", 196)).resolves.toEqual([]);
  });

  test("lists one page of repo issues with assigned_by", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([
        {
          number: 196,
          title: "one",
          body: "",
          state: "open",
          html_url: "https://gitea.example.test/owner/repo/issues/196",
          user: { login: "alice" },
          assignee: { login: "jumi" },
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        },
      ]);
    }) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const issues = await api.listRepoIssues("owner", "repo", { state: "open", type: "issues", assignedBy: "jumi" });
    expect(issues).toEqual([expect.objectContaining({ owner: "owner", repo: "repo", number: 196 })]);
    expect(urls[0]).toContain("/issues?state=open&type=issues&assigned_by=jumi&limit=50&page=1");
  });

  test("creates an issue dependency", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ number: 12 }, { status: 201 });
    }) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.createIssueDependency("owner", "repo", 12, { owner: "owner", repo: "repo", number: 196 });
    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/issues/12/dependencies",
      method: "POST",
      body: JSON.stringify({ index: 196, owner: "owner", repo: "repo" }),
    });
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

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.listPullReviews("owner", "repo", 7);

    expect(urls[0]).toContain("/pulls/7/reviews?limit=50&page=1");
    expect(urls[1]).toContain("/pulls/7/reviews?limit=50&page=2");
  });

  test("listPullReviewComments does not request /pulls/{index}/comments", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listPullReviewComments("owner", "repo", 7)).resolves.toEqual([]);
    expect(urls.some((url) => /\/pulls\/7\/comments(?:\?|$)/.test(url))).toBe(false);
  });

  test("listPullReviewComments fetches comments per review id", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/pulls/7/reviews?") && href.includes("page=1")) {
        return Response.json([{ id: 9 }, { id: 10 }]);
      }
      if (href.includes("/pulls/7/reviews/9/comments")) {
        return Response.json([{ id: 101, body: "a", path: "src/foo.ts", position: 12, commit_id: "oldsha" }]);
      }
      if (href.includes("/pulls/7/reviews/10/comments")) {
        return Response.json([{ id: 102, body: "b", path: "src/bar.ts", line: 40, position: 3, commit_id: "headsha" }]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const comments = await api.listPullReviewComments("owner", "repo", 7);
    expect(comments.map((comment) => comment.id)).toEqual([101, 102]);
    expect(comments.map((comment) => comment.new_position)).toEqual([12, 40]);
    expect(comments.map((comment) => comment.commit_id)).toEqual(["oldsha", "headsha"]);
    expect(comments.map((comment) => comment.pull_request_review_id)).toEqual([9, 10]);
    expect(urls.some((url) => url.includes("/pulls/7/reviews/9/comments?limit=50&page=1"))).toBe(true);
    expect(urls.some((url) => url.includes("/pulls/7/reviews/10/comments?limit=50&page=1"))).toBe(true);
    expect(urls.some((url) => /\/pulls\/7\/comments(?:\?|$)/.test(url))).toBe(false);
  });

  test("listPullReviewComments makes no nested GETs when reviews are empty", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listPullReviewComments("owner", "repo", 7)).resolves.toEqual([]);
    expect(urls).toEqual(["https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews?limit=50&page=1"]);
  });

  test("listPullReviewComments skips a review whose nested comments 404", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("/pulls/7/reviews?") && href.includes("page=1")) {
        return Response.json([{ id: 9 }, { id: 10 }]);
      }
      if (href.includes("/pulls/7/reviews/9/comments")) {
        return new Response("not found", { status: 404 });
      }
      if (href.includes("/pulls/7/reviews/10/comments")) {
        return Response.json([{ id: 102, body: "kept" }]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const comments = await api.listPullReviewComments("owner", "repo", 7);
    expect(comments.map((comment) => comment.id)).toEqual([102]);
    expect(comments.map((comment) => comment.body)).toEqual(["kept"]);
  });

  test("lists commit statuses and action job logs", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/actions/jobs/9/logs")) return new Response("##[error]boom\n", { status: 200 });
      if (href.includes("/actions/jobs")) return Response.json({ jobs: [{ id: 9, name: "build" }], total_count: 1 });
      if (href.includes("/commits/") && href.includes("/statuses")) {
        return Response.json([{ id: 1, context: "build", status: "failure" }]);
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listCommitStatuses("owner", "repo", "sha/1")).resolves.toEqual([
      { id: 1, context: "build", status: "failure" },
    ]);
    await expect(api.listCheckRuns("owner", "repo", "sha/1")).resolves.toEqual([]);
    await expect(api.listActionJobs("owner", "repo", { status: "failure" })).resolves.toEqual([
      { id: 9, name: "build" },
    ]);
    await expect(api.getActionJobLogs("owner", "repo", 9)).resolves.toBe("##[error]boom\n");
    expect(urls[0]).toContain("/commits/sha%2F1/statuses");
    expect(urls[1]).toContain("/actions/jobs?limit=50&page=1&order=desc&status=failure");
    expect(urls[2]).toContain("/actions/jobs/9/logs");
  });

  test("lists action jobs newest-first and filters head_sha client-side", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json({
        jobs: [
          { id: 12, name: "build", head_sha: "abc/def" },
          { id: 11, name: "other", head_sha: "ffff" },
        ],
        total_count: 2,
      });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listActionJobs("owner", "repo", { headSha: "abc/def" })).resolves.toEqual([
      { id: 12, name: "build", head_sha: "abc/def" },
    ]);
    expect(urls[0]).toContain("/actions/jobs?limit=50&page=1&order=desc");
    expect(urls[0]).not.toContain("head_sha");
  });

  test("a disabled Actions unit is an empty job list, not an error", async () => {
    for (const status of [403, 404]) {
      globalThis.fetch = (async () => new Response("unit disabled", { status })) as unknown as typeof fetch;
      await expect(
        new GiteaAPI("https://gitea.example.test", "token-1").listActionJobs("owner", "repo")
      ).resolves.toEqual([]);
    }
  });

  test("an Actions list that might hide a job still throws", async () => {
    globalThis.fetch = (async () =>
      new Response("API rate limit exceeded", { status: 403 })) as unknown as typeof fetch;
    await expect(new GiteaAPI("https://gitea.example.test", "token-1").listActionJobs("owner", "repo")).rejects.toThrow(
      "403"
    );
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(new GiteaAPI("https://gitea.example.test", "token-1").listActionJobs("owner", "repo")).rejects.toThrow(
      "500"
    );
  });

  test("throws useful errors for non-2xx responses", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(new GiteaAPI("https://gitea.example.test", "token-1").getPR("owner", "repo", 1)).rejects.toThrow(
      "500: nope"
    );
  });

  test("keeps the status, a short body, and scrubs the parent token", async () => {
    const token = "gitea_parent_secret_value";
    globalThis.fetch = (async () =>
      new Response(`denied ${token} ${"y".repeat(400)}`, { status: 502 })) as unknown as typeof fetch;

    const err = await new GiteaAPI(`https://gitea.example.test/${token}`, token).getPR("owner", "repo", 1).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : "";
    expect(message).toContain("Gitea API GET");
    expect(message).toContain("→ 502:");
    expect(message).toContain("denied");
    expect(message).toContain("https://gitea.example.test/***/api/v1/");
    expect(message).not.toContain(token);
    expect(message.endsWith("…")).toBe(true);
  });

  test("off-host attachment failure scrubs the parent token without sending it", async () => {
    const token = "gitea_parent_secret_value";
    let authorization: string | undefined = "unset";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(`echo ${token}`, { status: 403 });
    }) as unknown as typeof fetch;

    const err = await new GiteaAPI("https://gitea.example.test", token)
      .downloadAttachmentBytes("https://files.example/a")
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(authorization).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : "";
    expect(message).toContain("Gitea attachment GET");
    expect(message).toContain("→ 403:");
    expect(message).not.toContain(token);
  });

  test("same-host attachment still sends the parent token", async () => {
    let authorization: string | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

    const bytes = await new GiteaAPI("https://gitea.example.test", "token-1").downloadAttachmentBytes(
      "https://gitea.example.test/attachments/1"
    );
    expect(authorization).toBe("token token-1");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a base URL with a space still suppresses the sticky request string", async () => {
    const token = "gitea_parent_secret_value";
    globalThis.fetch = (async () => new Response(`leaked ${token}`, { status: 500 })) as unknown as typeof fetch;
    const err = await new GiteaAPI("https://gitea.example/proxy path", token).getPR("owner", "repo", 1).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(stickyFailureDetail(err, [token])).toBe("forge API request failed");
    const message = err instanceof Error ? err.message : "";
    expect(message).toContain("→ 500:");
    expect(message).toContain("proxy path");
    expect(message).not.toContain(token);
  });

  test("maps Gitea JSON to host-agnostic Task and Pull refs", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/issues/12")) {
        return Response.json({
          id: 200,
          number: 12,
          title: "Fix the thing",
          body: "Please implement this.",
          state: "open",
          html_url: "https://gitea.example.test/owner/repo/issues/12",
          user: { id: 1, login: "alice", full_name: "Alice", email: "a@b.c", avatar_url: "https://x" },
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
        html_url: "https://gitea.example.test/owner/repo/pulls/7",
        user: { login: "alice" },
        head: {
          label: "alice:feature",
          ref: "feature",
          sha: "abc123",
          repo: { full_name: "owner/repo", clone_url: "https://gitea.example.test/owner/repo.git" },
          repo_id: 10,
        },
        base: { ref: "main", sha: "def456" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const task = await api.getIssue("owner", "repo", 12);
    expect(task).toEqual({
      trackerRef: "12",
      number: 12,
      title: "Fix the thing",
      body: "Please implement this.",
      state: "open",
      html_url: "https://gitea.example.test/owner/repo/issues/12",
      user: { login: "alice" },
      assignee: { login: "jumi" },
      assignees: [{ login: "jumi" }],
      updated_at: "2026-05-23T00:00:00Z",
      created_at: "2026-05-23T00:00:00Z",
    });
    expect("avatar_url" in task.user).toBe(false);

    const pull = await api.getPR("owner", "repo", 7);
    expect(pull.forgeRef).toBe("7");
    expect(pull.number).toBe(7);
    expect(pull.head).toEqual({
      ref: "feature",
      sha: "abc123",
      repo: { full_name: "owner/repo", clone_url: "https://gitea.example.test/owner/repo.git" },
    });
    expect("label" in pull.head).toBe(false);
  });

  test("gets collaborator permission for write gating", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json({ permission: "write", role_name: "write", user: makeUser({ login: "alice" }) });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const info = await api.getCollaboratorPermission("owner", "repo", "alice");

    expect(info.permission).toBe("write");
    expect(urls[0]).toContain("/repos/owner/repo/collaborators/alice/permission");
  });
});
