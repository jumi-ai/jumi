import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { followUpStatePath, stuckStatePath } from "../src/claim.ts";
import { readFollowUpState, writeFollowUpState } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore, PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { MemorySkipLatchStore, parseWorkerLatchPath, skipLatchesFor } from "../src/skip_latches.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { readStuckState, writeStuckState } from "../src/stuck.ts";
import { handleIssueCancel } from "../src/worker.ts";
import { cancelLedgerWorkerJobs } from "../src/worker_webhook.ts";
import { makeComment, makeIssueJob, makeWorkerConfig } from "./fixtures.ts";

const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

describe("parseWorkerLatchPath", () => {
  test("parses worker HOME latch paths", () => {
    expect(parseWorkerLatchPath("/data/worker/jobs/kirmanak/demo/12.followup.json")).toEqual({
      home: "/data",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      kind: "followup",
    });
    expect(parseWorkerLatchPath("/tmp/x/worker/jobs/o/r/3.stuck.json")?.kind).toBe("stuck");
    expect(parseWorkerLatchPath("/tmp/12.stuck.json")).toBeUndefined();
  });
});

describe("MemorySkipLatchStore", () => {
  test("two callers sharing a store agree; separate stores do not", async () => {
    const shared = new MemorySkipLatchStore();
    await shared.put(key, { followup: { round: 3 }, stuck: { fingerprints: [{ kind: "action", hash: "aaa" }] } });
    expect((await shared.get(key)).followup).toEqual({ round: 3 });
    expect((await new MemorySkipLatchStore().get(key)).followup).toEqual({});
    await shared.delete(key);
    expect(await shared.get(key)).toEqual({ followup: {}, conflict: {}, ci: {}, stuck: {}, reviewStuck: {} });
  });
});

describe("HOME is not a source of truth", () => {
  test("leftover HOME follow-up files are ignored", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-latch-home-"));
    try {
      const path = followUpStatePath(home, key.owner, key.repo, key.issueNumber);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          prNumber: 127,
          round: 3,
          lastHeadSha: "abc",
          handledCommentIds: [],
          handledReviewIds: [],
          handledReviewFindings: [],
          updatedAt: "2026-05-23T00:00:00Z",
        })}\n`
      );
      expect(await readFollowUpState(path)).toMatchObject({ round: 0 });
      expect(JSON.parse(await readFile(path, "utf8")).round).toBe(3);
      const store = skipLatchesFor({ home });
      await writeFollowUpState(path, {
        prNumber: 127,
        round: 2,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect((await store.get(key)).followup).toMatchObject({ round: 2 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("kill switch deletes skip latches", () => {
  test("cancelLedgerWorkerJobs deletes the issue-keyed row even with no queued jobs", async () => {
    const store = new MemoryReviewJobStore();
    await store.skipLatches.put(key, {
      followup: { round: 3 },
      stuck: { fingerprints: [{ kind: "action", hash: "aaa" }] },
    });
    const comments: string[] = [];
    await cancelLedgerWorkerJobs({
      store,
      api: {
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o, _r, _i, body) => {
          comments.push(body);
          return makeComment({ body });
        },
        updateIssueComment: async (_o, _r, _id, body) => {
          comments.push(body);
          return makeComment({ body });
        },
      },
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
    });
    expect(await store.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
    expect(await store.readIssueSkipLatch(key.owner, key.repo, key.issueNumber)).toEqual({
      generation: 1,
      skipReason: null,
    });
    expect(comments).toEqual([]);
    await cancelLedgerWorkerJobs({
      store,
      api: {
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o, _r, _i, body) => {
          comments.push(body);
          return makeComment({ body });
        },
        updateIssueComment: async (_o, _r, _id, body) => {
          comments.push(body);
          return makeComment({ body });
        },
      },
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
    });
    expect(await store.readIssueSkipLatch(key.owner, key.repo, key.issueNumber)).toEqual({
      generation: 2,
      skipReason: null,
    });
  });

  test("cancelLedgerWorkerJobs bumps generation without deleting the Postgres row", async () => {
    const captured: string[] = [];
    const sql: SqlClient = {
      async unsafe(query: string) {
        captured.push(query);
        if (query.includes("RETURNING")) return [{ generation: 2, skip_reason: null }];
        return [];
      },
      async begin<T>(fn: (tx: SqlClient) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    await cancelLedgerWorkerJobs({
      store,
      api: {
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => makeComment({ body: "stopped" }),
        updateIssueComment: async () => makeComment({ body: "stopped" }),
      },
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
    });
    expect(captured.some((query) => query.includes("DELETE FROM issue_skip_latches"))).toBe(false);
    expect(
      captured.some(
        (query) =>
          query.includes("generation = issue_skip_latches.generation + 1") && query.includes("followup = '{}'::jsonb")
      )
    ).toBe(true);
  });

  test("handleIssueCancel deletes skip latches so a later follow-up is not stuck", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-latch-cancel-"));
    try {
      await writeStuckState(stuckStatePath(home, key.owner, key.repo, key.issueNumber), {
        fingerprints: [
          { kind: "action", hash: "aaa" },
          { kind: "action", hash: "bbb" },
          { kind: "action", hash: "aaa" },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        (await readStuckState(stuckStatePath(home, key.owner, key.repo, key.issueNumber))).fingerprints
      ).toHaveLength(3);
      await handleIssueCancel(makeWorkerConfig({ home }), {} as IssueApi, key.owner, key.repo, key.issueNumber);
      expect((await readStuckState(stuckStatePath(home, key.owner, key.repo, key.issueNumber))).fingerprints).toEqual(
        []
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("succeeded implement identity", () => {
  test("skip latches are not stored on a succeeded implement job payload", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    expect(leased?.payload).not.toBeNull();
    expect(leased?.payload).not.toHaveProperty("followup");
    expect(leased?.payload).not.toHaveProperty("stuck");
    await store.markPublished(leased!.id, "worker-1", { state: "succeeded" });
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(store.rows[0]?.payload).toEqual(leased!.payload);
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: false });
  });
});
