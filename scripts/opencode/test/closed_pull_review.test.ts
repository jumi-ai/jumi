import { describe, expect, test } from "bun:test";
import { buildBoardGroups } from "../src/board.ts";
import { encodeCiPendingWait } from "../src/ci.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { handleWorkerWebhookEvent } from "../src/worker_webhook.ts";
import { makeJob, makePayload, makePR } from "./fixtures.ts";

function closedPayload(action: "closed" | "merged", prNumber = 7) {
  return new TextEncoder().encode(
    JSON.stringify(
      makePayload({
        action,
        pull_request: makePR({ number: prNumber, state: "closed", merged: action === "merged" }),
      })
    )
  );
}

const POLICY = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [] as string[],
  botUsername: "jumi",
};

async function seedCiWait(store: MemoryReviewJobStore, delivery: string, prNumber = 7) {
  const now = Date.now();
  await store.enqueue(makeJob({ delivery, prNumber, headSha: "headsha" }), {
    waitUntilMs: now + 24 * 60 * 60 * 1000,
    waitMarker: encodeCiPendingWait(now),
    nowMs: now,
  });
}

describe("closed PR settles ci-wait review rows (#811)", () => {
  test("pull_request closed cancels a queued ci-wait-pending review row", async () => {
    const store = new MemoryReviewJobStore();
    await seedCiWait(store, "d-close-1");
    expect((await store.listInflight(10)).map((r) => r.state)).toEqual(["queued"]);

    const res = await handleWorkerWebhookEvent(
      new Uint8Array(closedPayload("closed")),
      "pull_request",
      "pull_request",
      "d-webhook-closed",
      POLICY,
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        review: store,
        sits: store.sits,
      } as never
    );
    expect(res.status).toBe(202);
    expect(store.rows[0]?.state).toBe("cancelled");
    expect(await store.sits.isPullClosed?.("kirmanak", "demo", 7)).toBe(true);
  });

  test("pull_request merged cancels a queued ci-wait-pending review row", async () => {
    const store = new MemoryReviewJobStore();
    await seedCiWait(store, "d-merge-1");
    const res = await handleWorkerWebhookEvent(
      new Uint8Array(closedPayload("merged")),
      "pull_request",
      "pull_request",
      "d-webhook-merged",
      POLICY,
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        review: store,
        sits: store.sits,
      } as never
    );
    expect(res.status).toBe(202);
    expect(store.rows[0]?.state).toBe("cancelled");
    expect(await store.sits.isPullClosed?.("kirmanak", "demo", 7)).toBe(true);
  });

  test("leased review row gets cancel_requested on close", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-leased" }));
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.state).toBe("leased");
    const res = await handleWorkerWebhookEvent(
      new Uint8Array(closedPayload("closed")),
      "pull_request",
      "pull_request",
      "d-webhook-leased",
      POLICY,
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        review: store,
        sits: store.sits,
      } as never
    );
    expect(res.status).toBe(202);
    expect((await store.get(leased!.id))?.state).toBe("leased");
    expect(await store.isCancelRequested(leased!.id)).toBe(true);
  });

  test("follow-up rows are untouched by the pull close", async () => {
    const store = new MemoryReviewJobStore();
    await seedCiWait(store, "d-with-followup");
    await store.enqueueIssue({
      delivery: "d-followup",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      action: "opened",
      title: "t",
      body: "",
      htmlUrl: "https://example/issues/12",
      issueUpdatedAt: new Date().toISOString(),
      defaultBranch: "main",
      cloneUrl: "https://example.git",
      receivedAt: new Date().toISOString(),
      mode: "follow-up",
      prNumber: 7,
      headSha: "headsha",
    });
    await handleWorkerWebhookEvent(
      new Uint8Array(closedPayload("closed")),
      "pull_request",
      "pull_request",
      "d-webhook-fu",
      POLICY,
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        review: store,
        sits: store.sits,
      } as never
    );
    expect(store.rows.find((r) => r.kind === "review")?.state).toBe("cancelled");
    expect(store.rows.find((r) => r.kind === "follow-up")?.state).toBe("queued");
  });

  test("board in_progress hides a queued review for a closed pull", async () => {
    const store = new MemoryReviewJobStore();
    await seedCiWait(store, "d-board");
    expect((await buildBoardGroups(store)).in_progress).toHaveLength(1);
    await store.sits.markPullClosed?.("kirmanak", "demo", 7);
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(0);
    expect(groups.needs_kick).toHaveLength(0);
  });

  test("engine tick settles a closed-pull row without touching the forge", async () => {
    const { processEngineTick } = await import("../src/server.ts");
    const { makeConfig } = await import("./fixtures.ts");
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ delivery: "d-engine-closed" }));
    await store.sits.markPullClosed?.("kirmanak", "demo", 7);
    let prCalls = 0;
    const api = {
      getPR: async () => {
        prCalls++;
        throw new Error("forge should not be called for a closed pull");
      },
    };
    const result = await processEngineTick(store, makeConfig(), api as never, "engine-1", {}, () => {});
    expect(result).toBe("processed");
    expect(prCalls).toBe(0);
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("PR is closed");
  });
});
