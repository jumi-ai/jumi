import { describe, expect, test } from "bun:test";
import { byteLength } from "../src/diagnostics.ts";
import { resolvePermissions } from "../src/permissions.ts";
import {
  fitReviewThread,
  formatPullReviewsXml,
  formatReviewCommentsXml,
  mapPullReview,
  mapReviewComment,
  mapReviewInline,
  mapReviewThread,
  type ReviewComment,
  type ReviewThread,
  serializeReviewThread,
} from "../src/review_context.ts";

function makeReviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 55,
    author: "jumi",
    created_at: "2026-05-23T00:00:00Z",
    body: "comment",
    ...overrides,
  };
}

describe("fitReviewThread", () => {
  test("is a no-op under the byte cap", () => {
    const thread: ReviewThread = {
      comments: [makeReviewComment({ body: "hello" })],
      linkedIssues: [
        {
          number: 12,
          state: "open",
          author: "alice",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          title: "Fix the thing",
          body: "Please implement this.",
          comments: [makeReviewComment({ id: 1, author: "alice", body: "ack" })],
        },
      ],
      pullReviews: [],
      reviewComments: [],
    };

    const result = fitReviewThread(thread, 200_000);
    expect(result.truncated).toBe(false);
    expect(result.droppedCommentBodies).toBe(0);
    expect(result.thread).toEqual(thread);
    expect(thread.comments[0]?.body).toBe("hello");
  });

  test("empties the oldest comment first", () => {
    const oldest = makeReviewComment({
      id: 1,
      created_at: "2026-01-01T00:00:00Z",
      body: `old-${"a".repeat(800)}`,
    });
    const newest = makeReviewComment({
      id: 2,
      created_at: "2026-06-01T00:00:00Z",
      body: `new-${"b".repeat(800)}`,
    });
    const thread: ReviewThread = { comments: [newest, oldest], linkedIssues: [] };
    const fullBytes = byteLength(serializeReviewThread(thread));
    const omittedThread: ReviewThread = {
      comments: [newest, { ...oldest, body: "[omitted; thread budget]" }],
      linkedIssues: [],
    };
    const omittedBytes = byteLength(serializeReviewThread(omittedThread));
    const maxBytes = omittedBytes + Math.floor((fullBytes - omittedBytes) / 2);

    const result = fitReviewThread(thread, maxBytes);
    expect(result.thread.comments.find((comment) => comment.id === 1)?.body).toBe("[omitted; thread budget]");
    expect(result.thread.comments.find((comment) => comment.id === 2)?.body).toBe(newest.body);
    expect(result.droppedCommentBodies).toBe(1);
    expect(result.truncated).toBe(true);
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(maxBytes);
    expect(oldest.body.startsWith("old-")).toBe(true);
  });

  test("keeps titles when comment bodies are dropped", () => {
    const thread: ReviewThread = {
      comments: [],
      linkedIssues: [
        {
          number: 12,
          state: "open",
          author: "alice",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          title: "Keep this title",
          body: "issue body",
          comments: [
            makeReviewComment({
              id: 9,
              created_at: "2026-01-01T00:00:00Z",
              body: "c".repeat(50_000),
            }),
          ],
        },
      ],
    };

    const result = fitReviewThread(thread, 5_000);
    expect(result.thread.linkedIssues[0]?.title).toBe("Keep this title");
    expect(result.thread.linkedIssues[0]?.number).toBe(12);
    expect(result.thread.linkedIssues[0]?.author).toBe("alice");
    expect(result.thread.linkedIssues[0]?.comments[0]?.created_at).toBe("2026-01-01T00:00:00Z");
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(5_000);
  });

  test("shrinks a 91k-style comment to a 32_768-byte prefix", () => {
    const body = "x".repeat(91_000);
    const thread: ReviewThread = {
      comments: [makeReviewComment({ body })],
      linkedIssues: [],
    };
    const maxBytes = 80_000;
    expect(byteLength(serializeReviewThread(thread))).toBeGreaterThan(maxBytes);

    const result = fitReviewThread(thread, maxBytes);
    expect(result.thread.comments[0]?.body.endsWith("\n[truncated]")).toBe(true);
    const prefix = result.thread.comments[0]?.body.slice(0, -"\n[truncated]".length) ?? "";
    expect(byteLength(prefix)).toBe(32_768);
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(maxBytes);
  });
});

describe("resolvePermissions", () => {
  test("dedupes logins case-insensitively and lowercases the detail", async () => {
    const seen: string[] = [];
    const result = await resolvePermissions(
      {
        getCollaboratorPermission: async (_owner, _repo, login) => {
          seen.push(login);
          return { permission: "ADMIN" };
        },
      },
      "kirmanak",
      "demo",
      ["Alice", "alice ", "ALICE", undefined, null, " ", "bob"]
    );
    // alice dedupes to one lookup; bob has no stubbed branch so returns admin too here;
    // the point is only distinct logins hit the forge.
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(0);
    expect(seen.sort()).toEqual(["Alice", "bob"].sort());
    expect(result.detail.get("alice")).toBe("admin");
    expect(result.detail.get("bob")).toBe("admin");
    expect(result.writes.get("alice")).toBe(true);
    expect(result.writes.get("bob")).toBe(true);
    expect(result.sampleError).toBeUndefined();
  });

  test("is fail-closed and counts per-login failures", async () => {
    const result = await resolvePermissions(
      {
        getCollaboratorPermission: async (_owner, _repo, login) => {
          if (login.toLowerCase() === "alice") return { permission: "write" };
          throw new Error("Gitea API GET /repos/kirmanak/demo/collaborators/bob/permission → 403: forbidden");
        },
      },
      "kirmanak",
      "demo",
      ["alice", "bob"]
    );
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.detail.get("alice")).toBe("write");
    expect(result.detail.get("bob")).toBe("none");
    expect(result.writes.get("alice")).toBe(true);
    expect(result.writes.get("bob")).toBe(false);
    expect(result.sampleError).toContain("403");
  });

  test("classifies write from role_name when permission is missing or not write", async () => {
    const result = await resolvePermissions(
      {
        getCollaboratorPermission: async (_owner, _repo, login) => {
          if (login === "alice") return { permission: "", role_name: "maintain" };
          return { permission: "read", role_name: "maintain" };
        },
      },
      "kirmanak",
      "demo",
      ["alice", "bob"]
    );
    expect(result.detail.get("alice")).toBe("maintain");
    expect(result.detail.get("bob")).toBe("read");
    expect(result.writes.get("alice")).toBe(true);
    expect(result.writes.get("bob")).toBe(true);
  });

  test("treats an unavailable permission API as all-failed", async () => {
    const result = await resolvePermissions({}, "kirmanak", "demo", ["alice", "BOB"]);
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.detail.get("alice")).toBe("none");
    expect(result.detail.get("bob")).toBe("none");
    expect(result.writes.get("alice")).toBe(false);
    expect(result.writes.get("bob")).toBe(false);
    expect(result.sampleError).toContain("unavailable");
  });
});

describe("mapReviewComment", () => {
  function makeForgeComment(author: string) {
    return {
      id: 10,
      body: "hello",
      user: { login: author },
      created_at: "2026-05-23T00:00:00Z",
      updated_at: "2026-05-23T00:00:00Z",
    };
  }

  test("tags writers as product and non-writers as discussion", () => {
    const permissions = new Map([
      ["alice", true],
      ["bob", false],
    ]);
    const detail = new Map([
      ["alice", "write"],
      ["bob", "read"],
    ]);

    const product = mapReviewComment(makeForgeComment("Alice"), permissions, detail);
    expect(product.permission).toBe("write");
    expect(product.intent).toBe("product");

    const discussion = mapReviewComment(makeForgeComment("bob"), permissions, detail);
    expect(discussion.permission).toBe("read");
    expect(discussion.intent).toBe("discussion");
  });

  test("omits tags when permissions are unknown", () => {
    const untagged = mapReviewComment(makeForgeComment("alice"));
    expect(untagged.permission).toBeUndefined();
    expect(untagged.intent).toBeUndefined();
  });
});

describe("mapReviewThread pull reviews", () => {
  const permissions = new Map([
    ["alice", true],
    ["bob", false],
  ]);
  const detail = new Map([
    ["alice", "write"],
    ["bob", "read"],
  ]);

  function makeReview(
    id: number,
    author: string,
    created_at: string,
    body: string,
    extra: Record<string, unknown> = {}
  ) {
    return {
      id,
      body,
      user: { login: author },
      submitted_at: created_at,
      updated_at: created_at,
      created_at,
      ...extra,
    };
  }

  function makeInline(
    id: number,
    author: string,
    created_at: string,
    body: string,
    extra: Record<string, unknown> = {}
  ) {
    return {
      id,
      body,
      user: { login: author },
      created_at,
      updated_at: created_at,
      ...extra,
    };
  }

  test("keeps writer review bodies with identity/state and sorts oldest-first", () => {
    const thread = mapReviewThread({
      prComments: [],
      linkedIssues: [],
      pullReviews: [
        makeReview(2, "alice", "2026-05-24T00:00:00Z", "Use postgres, not sqlite.", {
          state: "REQUEST_CHANGES",
          commit_id: "abc123",
        }),
        makeReview(1, "alice", "2026-05-23T00:00:00Z", "Earlier note.", { state: "COMMENTED" }),
      ],
      reviewComments: [],
      permissions,
      permissionDetail: detail,
    });

    expect(thread.pullReviews?.map((review) => review.id)).toEqual([1, 2]);
    expect(thread.pullReviews?.[1]?.body).toContain("Use postgres");
    expect(thread.pullReviews?.[1]?.state).toContain("request_changes");
    expect(thread.pullReviews?.[1]?.commit_id).toBe("abc123");
    expect(thread.pullReviews?.[1]?.intent).toBe("product");
    expect(thread.pullReviews?.[1]?.permission).toBe("write");
  });

  test("keeps dismissed reviews: dismissal is not a retraction", () => {
    const thread = mapReviewThread({
      prComments: [],
      linkedIssues: [],
      pullReviews: [makeReview(9, "alice", "2026-05-23T00:00:00Z", "Keep the retry budget.", { dismissed: true })],
      reviewComments: [],
      permissions,
      permissionDetail: detail,
    });
    expect(thread.pullReviews?.length).toBe(1);
    expect(thread.pullReviews?.[0]?.dismissed).toBe(true);
    expect(serializeReviewThread(thread)).toContain('dismissed="true"');
    expect(serializeReviewThread(thread)).toContain("Keep the retry budget.");
  });

  test("keeps inline-only instructions with path/line metadata and skips empty review bodies", () => {
    const thread = mapReviewThread({
      prComments: [],
      linkedIssues: [],
      pullReviews: [makeReview(7, "alice", "2026-05-23T00:00:00Z", "   ")],
      reviewComments: [
        makeInline(31, "alice", "2026-05-23T01:00:00Z", "Set timeout to 30s here.", {
          path: "src/worker.ts",
          new_position: 42,
          pull_request_review_id: 7,
          commit_id: "abc123",
        }),
      ],
      permissions,
      permissionDetail: detail,
    });
    // The empty review body carries no instruction; the inline still does.
    expect(thread.pullReviews?.length).toBe(0);
    expect(thread.reviewComments?.length).toBe(1);
    const xml = serializeReviewThread(thread);
    expect(xml).toContain("Set timeout to 30s here.");
    expect(xml).toContain('path="src/worker.ts"');
    expect(xml).toContain('line="42"');
    expect(xml).toContain('review_id="7"');
    expect(xml).toContain('intent="product"');
  });

  test("labels non-writer reviews and inlines as discussion", () => {
    const thread = mapReviewThread({
      prComments: [],
      linkedIssues: [],
      pullReviews: [makeReview(5, "bob", "2026-05-23T00:00:00Z", "Outsider suggestion.", { state: "COMMENTED" })],
      reviewComments: [makeInline(32, "bob", "2026-05-23T01:00:00Z", "Outsider inline.", { path: "src/a.ts" })],
      permissions,
      permissionDetail: detail,
    });
    expect(thread.pullReviews?.[0]?.intent).toBe("discussion");
    expect(thread.reviewComments?.[0]?.intent).toBe("discussion");
    const xml = serializeReviewThread(thread);
    expect(xml).toContain('intent="discussion"');
  });

  test("mapPullReview and mapReviewInline tag product/discussion like comments", () => {
    const product = mapPullReview(
      makeReview(1, "Alice", "2026-05-23T00:00:00Z", "Do X.", { state: "REQUEST_CHANGES" }),
      permissions,
      detail
    );
    expect(product.intent).toBe("product");
    const discussion = mapReviewInline(
      makeInline(2, "bob", "2026-05-23T00:00:00Z", "Maybe Y.", { path: "src/a.ts" }),
      permissions,
      detail
    );
    expect(discussion.intent).toBe("discussion");
  });

  test("formats review sections and keeps them under the thread budget", () => {
    const thread = mapReviewThread({
      prComments: [],
      linkedIssues: [],
      pullReviews: [makeReview(1, "alice", "2026-05-23T00:00:00Z", "Use postgres.", { state: "REQUEST_CHANGES" })],
      reviewComments: [makeInline(2, "alice", "2026-05-24T00:00:00Z", "z".repeat(100_000), { path: "src/a.ts" })],
      permissions,
      permissionDetail: detail,
    });
    expect(formatPullReviewsXml(thread.pullReviews ?? [])).toContain("<pull_reviews>");
    expect(formatReviewCommentsXml(thread.reviewComments ?? [])).toContain("<review_comments>");
    const fitted = fitReviewThread(thread, 5_000);
    expect(fitted.truncated).toBe(true);
    expect(byteLength(serializeReviewThread(fitted.thread))).toBeLessThanOrEqual(5_000);
    // The writer instruction survives fitting in some form (possibly omitted-body marker).
    expect(serializeReviewThread(fitted.thread)).toContain("<pull_reviews>");
  });
});
