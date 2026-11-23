import { describe, expect, test } from "bun:test";
import type { BoardPullForge } from "../src/board.ts";
import { createBoardFetchHandler } from "../src/board.ts";
import { isGonePublishError } from "../src/reclaim_publish.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, RECLAIM_PUBLISH_MAX_FAILURES } from "../src/review_jobs.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob } from "./fixtures.ts";

const GONE_404 = "GitHub API GET https://api.github.com/repos/kirmanak/demo/installation → 404: Not Found";
const TRANSIENT_502 = "Gitea API GET https://gitea.example.com/api/v1/repos/kirmanak/demo/pulls/7 → 502: Bad Gateway";

function memoryApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return makeReviewApi({
    // Keep the neutral PR open; publish failures come from the overridden sinks.
    createPullReview: async () => {
      throw new Error(TRANSIENT_502);
    },
    createIssueComment: async () => {
      throw new Error(TRANSIENT_502);
    },
    ...overrides,
  }) as ReviewApi;
}

/** Seed one leased review row whose lease already expired. */
async function seedExpiredLease(store: MemoryReviewJobStore): Promise<number> {
  await store.enqueue(makeJob({ delivery: "d-expired" }));
  const leased = await store.lease("dead-engine", 1, new Date(Date.now() - 60_000));
  if (!leased) throw new Error("expected a leased job");
  return leased.id;
}

describe("reclaim publish fallback (#810)", () => {
  test("gone publish error settles a max-attempts row to failed in one pass", async () => {
    const store = new MemoryReviewJobStore();
    const id = await seedExpiredLease(store);
    const api = memoryApi({
      getPR: async () => {
        throw new Error(GONE_404);
      },
    });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    const row = await store.get(id);
    expect(row?.state).toBe("failed");
    expect(row?.resultReason).toContain("404");
    expect(row?.publishedAt).not.toBeNull();

    // A later reclaim pass does not touch the settled row.
    const updatedAt = row?.updatedAt;
    const summary = await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);
    expect(summary).toEqual({ requeued: 0, published: 0 });
    expect((await store.get(id))?.updatedAt).toBe(updatedAt);
    expect((await store.get(id))?.state).toBe("failed");
  });

  test("closed-PR probe settles a transient-looking publish error without a gone status", async () => {
    const store = new MemoryReviewJobStore();
    const id = await seedExpiredLease(store);
    // The status sink fails transiently, but the live PR is merged: permanent.
    // (The skip path posts the status before any review sink runs.)
    const api = memoryApi({
      createCommitStatus: async () => {
        throw new Error(TRANSIENT_502);
      },
      getPR: async (_owner, _repo, index) =>
        ({
          number: index,
          title: "Add feature",
          body: "",
          state: "closed",
          html_url: "https://example.test/x/y/pulls/7",
          user: { login: "alice" },
          head: { ref: "feature", sha: "headsha", repo: null },
          base: { ref: "main", sha: "basesha" },
          merged: true,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        }) as never,
    });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    const row = await store.get(id);
    expect(row?.state).toBe("failed");
    expect(row?.resultReason).toContain("502");
  });

  test("transient publish errors settle failed once the retry bound is reached", async () => {
    const store = new MemoryReviewJobStore();
    const id = await seedExpiredLease(store);
    const leased = await store.get(id);
    await store.saveResult(id, leased!.leasedBy!, {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const api = memoryApi();

    for (let n = 1; n < RECLAIM_PUBLISH_MAX_FAILURES; n++) {
      await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 2 }), () => undefined);
      const row = await store.get(id);
      expect(row?.state).toBe("leased");
      expect(row?.leasedBy).toBeNull();
      expect(row?.reclaimPublishFailures ?? 0).toBe(n);
    }

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 2 }), () => undefined);
    const settled = await store.get(id);
    expect(settled?.state).toBe("failed");
    expect(settled?.resultReason).toContain("502");

    // Terminal: later passes leave it alone.
    const updatedAt = settled?.updatedAt;
    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 2 }), () => undefined);
    expect((await store.get(id))?.updatedAt).toBe(updatedAt);
  });

  test("unit: gone-error shape covers 404 and 410 on either forge", () => {
    expect(isGonePublishError(new Error(GONE_404))).toBe(true);
    expect(isGonePublishError(new Error("Gitea API GET https://gitea.example.com/api/v1/repos/a/b → 410: Gone"))).toBe(
      true
    );
    expect(isGonePublishError(new Error(TRANSIENT_502))).toBe(false);
    expect(isGonePublishError(new Error("boom"))).toBe(false);
  });
});

/** Seed one terminal failed review with a kickable reason; returns the terminal id. */
async function seedFailed(store: MemoryReviewJobStore, reason = "boom"): Promise<number> {
  await store.enqueue(makeJob({ delivery: "d-kick" }));
  const leased = await store.lease("worker", 60_000);
  if (!leased) throw new Error("expected a leased job");
  await store.saveResult(leased.id, "worker", { kind: "error", error: reason });
  await store.markPublished(leased.id, "worker", { state: "failed", reason });
  return leased.id;
}

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

function kickRequest(body: Record<string, unknown>): Request {
  return new Request("https://board.test/api/board/kick", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...EDGE_HEADERS }),
    body: JSON.stringify(body),
  });
}

function boardForge(pr: { state: string; merged: boolean }, repoFullName = "kirmanak/demo"): BoardPullForge {
  return {
    getPR: async (_owner, _repo, index) =>
      ({
        number: index,
        title: "Add feature",
        body: "",
        state: pr.state,
        html_url: "https://example.test/x/y/pulls/7",
        user: { login: "alice" },
        head: { ref: "feature", sha: "headsha", repo: null },
        base: { ref: "main", sha: "basesha" },
        merged: pr.merged,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      }) as never,
    closePullRequest: async () => undefined as never,
    reopenPullRequest: async () => undefined as never,
    getRepo: async () => ({ default_branch: "main", full_name: repoFullName }),
  };
}

describe("requeue kick forge gate (#810)", () => {
  test("store: merged and closed PRs refuse without a job and log the refusal", async () => {
    for (const forge of [
      { state: "closed", merged: true },
      { state: "closed", merged: false },
    ]) {
      const store = new MemoryReviewJobStore();
      const terminalId = await seedFailed(store);
      const outcome = await store.requeueKick({
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        headSha: "headsha",
        kick: "boom",
        actor: "operator",
        idempotencyKey: `kick-closed-${forge.merged}`,
        delivery: "board-kick:test",
        forge,
      });
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("expected rejection");
      expect(outcome.code).toBe("not-kickable");
      expect(outcome.terminalId).toBe(terminalId);
      // No job created: only the terminal row exists.
      expect(store.rows).toHaveLength(1);
      const logged = await store.getKickByIdempotencyKey(`kick-closed-${forge.merged}`);
      expect(logged?.result).toBe("not-kickable");
      expect(logged?.terminalJobId).toBe(terminalId);
    }
  });

  test("store: missing PR refuses as not-found; canonical repo retargets the new row", async () => {
    const missing = new MemoryReviewJobStore();
    const terminalId = await seedFailed(missing);
    const notFound = await missing.requeueKick({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      kick: "boom",
      actor: "operator",
      idempotencyKey: "kick-missing",
      delivery: "board-kick:test",
      forge: { notFound: true },
    });
    expect(notFound.status).toBe("rejected");
    if (notFound.status !== "rejected") throw new Error("expected rejection");
    expect(notFound.code).toBe("not-found");
    expect(missing.rows).toHaveLength(1);
    expect((await missing.getKickByIdempotencyKey("kick-missing"))?.terminalJobId).toBe(terminalId);

    const moved = new MemoryReviewJobStore();
    await seedFailed(moved);
    const ok = await moved.requeueKick({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      kick: "boom",
      actor: "operator",
      idempotencyKey: "kick-moved",
      delivery: "board-kick:test",
      forge: { state: "open", merged: false, canonicalFullName: "jumi-ai/demo" },
    });
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") throw new Error("expected ok");
    expect(ok.job.owner).toBe("jumi-ai");
    expect(ok.job.repo).toBe("demo");
  });

  test("board: merged PR kick is refused, open PR kick still queues", async () => {
    const mergedStore = new MemoryReviewJobStore();
    await seedFailed(mergedStore);
    const mergedHandler = createBoardFetchHandler({
      store: mergedStore,
      getGrantNotice: () => undefined,
      logger: () => undefined,
      forgeApi: boardForge({ state: "closed", merged: true }),
    });
    const item = { owner: "kirmanak", repo: "demo", number: 7, commit: "headsha", kick: "boom" };
    const refused = await mergedHandler(kickRequest({ ...item, idempotencyKey: "board-merged" }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code: string }).code).toBe("not-kickable");
    // Refusal is in the kick log and no job was queued.
    expect((await mergedStore.getKickByIdempotencyKey("board-merged"))?.result).toBe("not-kickable");
    expect(mergedStore.rows).toHaveLength(1);

    const openStore = new MemoryReviewJobStore();
    await seedFailed(openStore);
    const openHandler = createBoardFetchHandler({
      store: openStore,
      getGrantNotice: () => undefined,
      logger: () => undefined,
      forgeApi: boardForge({ state: "open", merged: false }),
    });
    const ok = await openHandler(kickRequest({ ...item, idempotencyKey: "board-open" }));
    expect(ok.status).toBe(200);
    expect(openStore.rows).toHaveLength(2);
  });
});
