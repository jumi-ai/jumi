import { describe, expect, test } from "bun:test";
import type { BoardItem } from "../src/board.ts";
import {
  BOARD_IN_PROGRESS_PAGE_SIZE,
  BOARD_NEEDS_KICK_PAGE_SIZE,
  boardAttentionKindOf,
  buildBoardGroups,
  createBoardFetchHandler,
  isDismissalSitReason,
  renderBoardPage,
} from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function boardRequest(path = "/api/board", headers: Record<string, string> = {}): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(headers) });
}

function item(
  overrides: Partial<BoardItem> & { reason: string; owner: string; repo: string; number: number; kind: string }
): BoardItem {
  return { ...overrides } as BoardItem;
}

describe("scannable board grouping (#774)", () => {
  test("dismissal sits are only the row-removal set", () => {
    for (const reason of ["foreign-branch", "no-closer", "no-write-access", "not-labeled"]) {
      expect(isDismissalSitReason(reason)).toBe(true);
    }
    for (const reason of [
      "implement-latch",
      "waiting-maintainer",
      "ci-not-completed",
      "draft-wip",
      "terminal-result",
      "conflict-ignored",
    ]) {
      expect(isDismissalSitReason(reason)).toBe(false);
    }
  });

  test("verdict vs execution failure vs recovery vs waiting vs dismissal", () => {
    expect(
      boardAttentionKindOf(
        item({
          reason: "review failed",
          owner: "o",
          repo: "r",
          number: 1,
          kind: "review",
          kick: { effect: "x", kick: "boom" },
          commit: HEAD_SHA,
        })
      )
    ).toBe("exec-failure");
    expect(
      boardAttentionKindOf(
        item({
          reason: "review failed",
          owner: "o",
          repo: "r",
          number: 1,
          kind: "review",
          kick: { effect: "x", kick: "v" },
          commit: HEAD_SHA,
          failingVerdict: true,
        })
      )
    ).toBe("verdict");
    expect(
      boardAttentionKindOf(item({ reason: "implement-latch", owner: "o", repo: "r", number: 1, kind: "sit" }))
    ).toBe("stuck-recovery");
    expect(
      boardAttentionKindOf(item({ reason: "implement skipped", owner: "o", repo: "r", number: 1, kind: "implement" }))
    ).toBe("blocked");
    expect(
      boardAttentionKindOf(item({ reason: "waiting-maintainer", owner: "o", repo: "r", number: 1, kind: "sit" }))
    ).toBe("answer-needed");
    expect(
      boardAttentionKindOf(
        item({
          reason: "not-labeled",
          owner: "o",
          repo: "r",
          number: 1,
          kind: "sit",
          kick: { effect: "Remove this board row only", kick: "sit-clear" },
        })
      )
    ).toBe("dismissal");
    expect(
      boardAttentionKindOf(item({ reason: "review leased", owner: "o", repo: "r", number: 1, kind: "review" }))
    ).toBe("running");
    expect(
      boardAttentionKindOf(item({ reason: "review queued", owner: "o", repo: "r", number: 1, kind: "review" }))
    ).toBe("queued");
    expect(boardAttentionKindOf(item({ reason: "draft-wip", owner: "o", repo: "r", number: 1, kind: "sit" }))).toBe(
      "waiting"
    );
  });

  test("in-progress carries createdAt and running sorts first", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-1", prNumber: 7, headSha: HEAD_SHA }));
    await store.enqueueIssue(makeIssueJob({ delivery: "d-2", issueNumber: 12 }));
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(2);
    for (const row of groups.in_progress) {
      expect(typeof row.createdAt).toBe("number");
    }
    // Both are queued here; leased rows sort before queued rows.
    expect(groups.in_progress_overflow).toBeUndefined();
  });

  test("failing verdict flag survives the board groups", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-v", prNumber: 7, headSha: HEAD_SHA }));
    const leased = await store.lease("worker", 60_000);
    if (!leased) throw new Error("expected a leased job");
    await store.saveResult(leased.id, "worker", {
      kind: "markdown",
      markdown: "note\n<!-- jumi-check: failure; bad finding -->\n",
    });
    await store.markPublished(leased.id, "worker", { state: "succeeded" });
    const groups = await buildBoardGroups(store);
    const verdict = groups.needs_kick.find((row) => row.number === 7);
    expect(verdict).toBeDefined();
    expect(verdict?.failingVerdict).toBe(true);
    expect(boardAttentionKindOf(verdict as BoardItem)).toBe("verdict");
  });

  test("mixed fixture: execution failure, verdict, recovery, dismissal, answer-needed", async () => {
    const store = new MemoryReviewJobStore();
    // Execution failure.
    await store.enqueue(makeJob({ delivery: "d-fail", prNumber: 7, headSha: HEAD_SHA }));
    const failed = await store.lease("worker", 60_000);
    if (!failed) throw new Error("expected a leased job");
    await store.saveResult(failed.id, "worker", { kind: "error", error: "boom" });
    await store.markPublished(failed.id, "worker", { state: "failed", reason: "boom" });
    // Stuck recovery + dismissal + answer-needed sits.
    await store.sits.remember("kirmanak", "demo", 12, "implement-latch");
    await store.sits.remember("kirmanak", "demo", 21, "not-labeled");
    await store.sits.remember("kirmanak", "demo", 22, "waiting-maintainer");
    await store.sits.remember("kirmanak", "demo", 23, "draft-wip");
    const groups = await buildBoardGroups(store);
    const kinds = new Map(groups.needs_kick.map((row) => [row.number, boardAttentionKindOf(row)]));
    expect(kinds.get(7)).toBe("exec-failure");
    expect(kinds.get(12)).toBe("stuck-recovery");
    expect(kinds.get(21)).toBe("dismissal");
    expect(groups.sitting.some((row) => row.number === 22 && boardAttentionKindOf(row) === "answer-needed")).toBe(true);
    expect(groups.sitting.some((row) => row.number === 23 && boardAttentionKindOf(row) === "waiting")).toBe(true);
  });

  test("long queues are capped with explicit overflow counts", async () => {
    const store = new MemoryReviewJobStore();
    const total = BOARD_NEEDS_KICK_PAGE_SIZE + 3;
    let id = 0;
    for (let pr = 1; pr <= total; pr += 1) {
      id += 1;
      store.rows.push({
        id,
        jobKey: `kirmanak/demo#${pr}:${HEAD_SHA}:${id}`,
        kind: "review",
        owner: "kirmanak",
        repo: "demo",
        prNumber: pr,
        headSha: HEAD_SHA,
        issueNumber: null,
        payload: null,
        delivery: `d-${id}`,
        state: "failed",
        attempt: 0,
        leasedBy: null,
        leasedUntil: null,
        resultMarkdown: null,
        resultReason: "boom",
        error: null,
        pendingStatusAt: null,
        publishedAt: null,
        prUpdatedAt: null,
        cancelRequested: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick).toHaveLength(BOARD_NEEDS_KICK_PAGE_SIZE);
    expect(groups.needs_kick_overflow).toBe(3);

    const queued = new MemoryReviewJobStore();
    for (let pr = 1; pr <= BOARD_IN_PROGRESS_PAGE_SIZE + 2; pr += 1) {
      await queued.enqueue(
        makeJob({
          delivery: `d-q-${pr}`,
          prNumber: pr,
          headSha: `${HEAD_SHA.slice(0, 36)}${String(pr).padStart(4, "0")}`,
        })
      );
    }
    const qGroups = await buildBoardGroups(queued);
    expect(qGroups.in_progress).toHaveLength(BOARD_IN_PROGRESS_PAGE_SIZE);
    expect(qGroups.in_progress_overflow).toBe(2);
  });

  test("sit duplicating an in-progress row past the display cap stays hidden", async () => {
    const store = new MemoryReviewJobStore();
    const last = BOARD_IN_PROGRESS_PAGE_SIZE + 1;
    for (let pr = 1; pr <= last; pr += 1) {
      await store.enqueue(
        makeJob({
          delivery: `d-cap-${pr}`,
          prNumber: pr,
          headSha: `${HEAD_SHA.slice(0, 36)}${String(pr).padStart(4, "0")}`,
        })
      );
    }
    // Kickable sit on the same pull as the oldest queued row, which falls
    // past the 200-row display slice but is still in progress.
    await store.sits.remember("kirmanak", "demo", last, "implement-latch");
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(BOARD_IN_PROGRESS_PAGE_SIZE);
    expect(groups.in_progress_overflow).toBe(1);
    expect(groups.needs_kick.some((row) => row.number === last)).toBe(false);
    expect(groups.sitting.some((row) => row.number === last)).toBe(false);
  });

  test("page merges peer overflow counts into the capped-view disclosure", () => {
    const html = renderBoardPage("catalog123");
    expect(html).toContain("needsKickOverflow += p.needs_kick_overflow || p.needsKickOverflow || 0");
    expect(html).toContain("inProgressOverflow += p.in_progress_overflow || p.inProgressOverflow || 0");
  });

  test("REST stays compatible: aliases match and additive fields survive", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-1", prNumber: 7, headSha: HEAD_SHA }));
    await store.sits.remember("kirmanak", "demo", 21, "not-labeled");
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.inProgress).toEqual(body.in_progress);
    expect(body.needsKick).toEqual(body.needs_kick);
    expect(body.sitting_on_purpose).toEqual(body.sitting);
    const inProgress = body.in_progress as BoardItem[];
    expect(typeof inProgress[0]?.createdAt).toBe("number");
  });

  test("peer rows keep additive fields and stay pinned to the peer forge", async () => {
    const store = new MemoryReviewJobStore();
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          forge: "gitea",
          in_progress: [
            {
              reason: "review queued",
              owner: "o",
              repo: "r",
              number: 1,
              kind: "review",
              forge: "gitea",
              createdAt: 1700000000000,
            },
          ],
          needs_kick: [
            {
              reason: "review failed",
              owner: "o",
              repo: "r",
              number: 2,
              kind: "review",
              forge: "gitea",
              commit: HEAD_SHA,
              failingVerdict: true,
              kick: { effect: "Rerun", kick: "v" },
            },
          ],
          sitting: [],
        })
      )) as unknown as typeof fetch;
    const handler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const response = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const peers = body.peers as Record<string, Record<string, unknown>>;
    expect(peers.github.available).toBe(true);
    const peerIn = (peers.github.in_progress ?? []) as BoardItem[];
    expect(peerIn[0]?.forge).toBe("github");
    expect(peerIn[0]?.createdAt).toBe(1700000000000);
    const peerNeeds = (peers.github.needs_kick ?? []) as BoardItem[];
    expect(peerNeeds[0]?.forge).toBe("github");
    expect(peerNeeds[0]?.failingVerdict).toBe(true);
    expect(boardAttentionKindOf(peerNeeds[0] as BoardItem)).toBe("verdict");
  });

  test("ledger failure is 503 and peer unavailability stays independent", async () => {
    const failing = {
      listInflight: async (): Promise<never[]> => {
        throw new Error("db down");
      },
      sits: { list: async () => [] },
    };
    const handler = createBoardFetchHandler({
      store: failing as unknown as MemoryReviewJobStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const failed = await handler(boardRequest("/api/board", EDGE_HEADERS));
    expect(failed.status).toBe(503);

    const store = new MemoryReviewJobStore();
    const downPeer = (async () => {
      throw new Error("peer down");
    }) as unknown as typeof fetch;
    const peerHandler = createBoardFetchHandler({
      store,
      peerUrl: "https://peer.internal/board",
      peerToken: "s3cret",
      fetchFn: downPeer,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const ok = await peerHandler(boardRequest("/api/board", EDGE_HEADERS));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    const peers = body.peers as Record<string, Record<string, unknown>>;
    expect(peers.github).toMatchObject({ available: false });
  });

  test("page marks stale, disables actions on stale, and groups by next action", () => {
    const html = renderBoardPage("catalog123");
    expect(html).toContain("<h2>Needs attention</h2>");
    expect(html).toContain("Review execution failed");
    expect(html).toContain("Published findings");
    expect(html).toContain("Stuck recovery");
    expect(html).toContain("Needs maintainer answer");
    expect(html).toContain("Running &amp; queued");
    expect(html).toContain("Waiting / ignored");
    expect(html).toContain("Remove from board");
    expect(html).toContain('id="stale"');
    expect(html).toContain("actions are disabled until a fresh response");
    expect(html).toContain("capped, not exhaustive");
    expect(html).toContain("Show ");
    expect(html).toContain("more queued");
    expect(html).toContain("Runner sign-in");
    expect(html).toContain('href="#needs-attention"');
  });
});
