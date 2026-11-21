import { describe, expect, test } from "bun:test";
import { BOARD_NEEDS_KICK_PAGE_SIZE, buildBoardGroups, createBoardFetchHandler } from "../src/board.ts";
import { MemoryReviewJobStore, type ReviewJobRecord } from "../src/review_jobs.ts";

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function boardRequest(path = "/api/board", headers: Record<string, string> = {}): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(headers) });
}

let nextId = 1;

function terminalReview(opts: {
  prNumber: number;
  headSha?: string;
  state?: ReviewJobRecord["state"];
  resultReason?: string | null;
  error?: string | null;
}): ReviewJobRecord {
  const id = nextId++;
  const headSha = opts.headSha ?? HEAD_SHA;
  return {
    id,
    jobKey: `kirmanak/demo#${opts.prNumber}:${headSha}:${id}`,
    kind: "review",
    owner: "kirmanak",
    repo: "demo",
    prNumber: opts.prNumber,
    headSha,
    issueNumber: null,
    payload: null,
    delivery: `d-${id}`,
    state: opts.state ?? "failed",
    attempt: 0,
    leasedBy: null,
    leasedUntil: null,
    resultMarkdown: null,
    resultReason: opts.resultReason ?? "boom",
    error: opts.error ?? null,
    pendingStatusAt: null,
    publishedAt: null,
    prUpdatedAt: null,
    cancelRequested: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function succeededReview(prNumber: number): ReviewJobRecord {
  const id = nextId++;
  return {
    id,
    jobKey: `kirmanak/demo#${prNumber}:head-${id}:${id}`,
    kind: "review",
    owner: "kirmanak",
    repo: "demo",
    prNumber,
    headSha: `head${prNumber}-${id}`,
    issueNumber: null,
    payload: null,
    delivery: `d-${id}`,
    state: "succeeded",
    attempt: 0,
    leasedBy: null,
    leasedUntil: null,
    resultMarkdown: "done",
    resultReason: null,
    error: null,
    pendingStatusAt: null,
    publishedAt: null,
    prUpdatedAt: null,
    cancelRequested: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("recovery board keeps unresolved work visible (#708)", () => {
  test("older eligible failure survives more than a window of unrelated completions", async () => {
    nextId = 1;
    const store = new MemoryReviewJobStore();
    store.rows.push(terminalReview({ prNumber: 7 }));
    for (let pr = 1000; pr < 1000 + BOARD_NEEDS_KICK_PAGE_SIZE + 50; pr += 1) {
      store.rows.push(succeededReview(pr));
    }
    const listed = await store.listTerminalReviews();
    expect(listed.some((r) => r.prNumber === 7)).toBe(true);
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick.some((item) => item.number === 7 && item.kind === "review")).toBe(true);
    expect(groups.needs_kick_overflow).toBeUndefined();
  });

  test("newer success on the same item clears the older failure", async () => {
    nextId = 1;
    const store = new MemoryReviewJobStore();
    store.rows.push(terminalReview({ prNumber: 7 }));
    store.rows.push(succeededReview(7));
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick.filter((item) => item.number === 7)).toHaveLength(0);
    expect(groups.needs_kick_overflow).toBeUndefined();
  });

  test("ineligible rows do not count toward overflow", async () => {
    nextId = 1;
    const store = new MemoryReviewJobStore();
    store.rows.push(terminalReview({ prNumber: 7 }));
    for (let pr = 1000; pr < 1000 + BOARD_NEEDS_KICK_PAGE_SIZE + 50; pr += 1) {
      store.rows.push(succeededReview(pr));
    }
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick).toHaveLength(1);
    expect(groups.needs_kick_overflow).toBeUndefined();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const body = (await (await handler(boardRequest("/api/board", EDGE_HEADERS))).json()) as Record<string, unknown>;
    expect(body.needs_kick_overflow).toBeUndefined();
    expect(body.needsKickOverflow).toBeUndefined();
  });

  test("overflow appears when eligible items exceed the cap and is absent otherwise", async () => {
    nextId = 1;
    const store = new MemoryReviewJobStore();
    const total = BOARD_NEEDS_KICK_PAGE_SIZE + 1;
    for (let pr = 1; pr <= total; pr += 1) {
      store.rows.push(terminalReview({ prNumber: pr }));
    }
    const groups = await buildBoardGroups(store);
    expect(groups.needs_kick).toHaveLength(BOARD_NEEDS_KICK_PAGE_SIZE);
    expect(groups.needs_kick_overflow).toBe(1);
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });
    const body = (await (await handler(boardRequest("/api/board", EDGE_HEADERS))).json()) as Record<string, unknown>;
    expect(body.needs_kick_overflow).toBe(1);
    expect(body.needsKickOverflow).toBe(1);
    expect((body.needs_kick as unknown[]).length).toBe(BOARD_NEEDS_KICK_PAGE_SIZE);

    nextId = 1;
    const small = new MemoryReviewJobStore();
    small.rows.push(terminalReview({ prNumber: 7 }));
    const smallGroups = await buildBoardGroups(small);
    expect(smallGroups.needs_kick).toHaveLength(1);
    expect(smallGroups.needs_kick_overflow).toBeUndefined();
    const smallHandler = createBoardFetchHandler({ store: small, getGrantNotice: () => undefined, logger: () => {} });
    const smallBody = (await (await smallHandler(boardRequest("/api/board", EDGE_HEADERS))).json()) as Record<
      string,
      unknown
    >;
    expect(smallBody.needs_kick_overflow).toBeUndefined();
    expect(smallBody.needsKickOverflow).toBeUndefined();
  });
});
