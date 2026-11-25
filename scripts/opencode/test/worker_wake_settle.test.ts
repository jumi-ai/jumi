import { describe, expect, test } from "bun:test";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore, workerJobKey } from "../src/review_jobs.ts";
import type { IssueJob } from "../src/types.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssueJob, makeWorkerConfig } from "./fixtures.ts";

function workerApi(overrides: Partial<IssueApi> = {}): IssueApi {
  return makeIssueApi({
    findStickyIssueComment: async () => ({ id: 9 }),
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    ...overrides,
  });
}

/** Payload for a directly-recorded wake cause, mirroring what enqueue stores. */
function wakePayload(job: IssueJob, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueNumber: job.issueNumber,
    title: job.title,
    body: job.body,
    htmlUrl: job.htmlUrl,
    issueUpdatedAt: job.issueUpdatedAt,
    defaultBranch: job.defaultBranch,
    cloneUrl: job.cloneUrl,
    action: job.action,
    trigger: job.trigger,
    generation: 0,
    ...overrides,
  };
}

const OWNER = "kirmanak";
const REPO = "demo";
const ISSUE = 12;
const BOARD_KEY = `${OWNER}/${REPO}#${ISSUE}`;

function followUpJob(headSha: string, extra: Partial<IssueJob> = {}): IssueJob {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    headSha,
    trigger: { event: "review-failure", sender: "jumi" },
    ...extra,
  });
}

describe("worker wake settlement (memory)", () => {
  test("head-changed skip parks the pending cause, queues nothing, keeps the new-head job", async () => {
    const store = new MemoryReviewJobStore();
    const jobA = followUpJob("oldsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const logs: string[] = [];
    const result = await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi(),
      "worker-1",
      {
        followUp: async () => {
          // A distinct cause arrives while A is leased.
          expect(
            await store.wakeCauses.record({
              jobKey: keyA,
              owner: OWNER,
              repo: REPO,
              issueNumber: ISSUE,
              prNumber: 127,
              headSha: "oldsha",
              delivery: "wake-1",
              payload: wakePayload(jobA, { trigger: { event: "issue_comment", sender: "alice" } }),
            })
          ).toBe("recorded");
          return { status: "skipped", reason: "PR head changed from oldsha to newsha" };
        },
      },
      (message) => logs.push(message)
    );
    expect(result).toBe("processed");
    // The old row settles skipped, the cause parks head-changed, and nothing
    // is queued behind the settled key.
    expect(store.rows.find((row) => row.headSha === "oldsha")?.state).toBe("skipped");
    expect(await store.wakeCauses.countPending(keyA)).toBe(0);
    const parked = await store.wakeCauses.list(keyA, "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("head-changed");
    expect(store.rows.filter((row) => row.jobKey === keyA && row.state === "queued")).toHaveLength(0);
    // The new-head successor is still enqueued exactly as before.
    const successor = store.rows.find((row) => row.headSha === "newsha");
    expect(successor?.kind).toBe("follow-up");
    expect(successor?.state).toBe("queued");
    expect(logs.some((line) => line.includes("after PR head changed"))).toBe(true);
    expect(logs.some((line) => line.includes(`parked 1 pending wake(s) for ${BOARD_KEY}: head-changed`))).toBe(true);
  });

  test("no-changes with a pending cause promotes one pass, logs, and clears the board reason", async () => {
    // Control: no pending cause, so the finished pass's reason stays on the board.
    const control = new MemoryReviewJobStore();
    await control.enqueueIssue(followUpJob("headsha"));
    const controlLogs: string[] = [];
    await processWorkerTick(
      control,
      makeWorkerConfig(),
      workerApi(),
      "worker-1",
      { followUp: async () => ({ status: "no-changes" }) },
      (message) => controlLogs.push(message)
    );
    expect(await control.sits.get(OWNER, REPO, ISSUE)).toMatchObject({ reason: "no-changes" });
    expect(controlLogs.some((line) => line.includes("pending wake(s)"))).toBe(false);

    // With a pending cause: one promoted pass runs, the log line prints, and
    // the board reason is cleared instead of sitting next to the successor.
    const store = new MemoryReviewJobStore();
    const jobA = followUpJob("headsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const pendingTrigger = { event: "issue_comment", sender: "alice" };
    const logs: string[] = [];
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi(),
      "worker-1",
      {
        followUp: async () => {
          expect(
            await store.wakeCauses.record({
              jobKey: keyA,
              owner: OWNER,
              repo: REPO,
              issueNumber: ISSUE,
              prNumber: 127,
              headSha: "headsha",
              delivery: "wake-1",
              payload: wakePayload(jobA, { trigger: pendingTrigger }),
            })
          ).toBe("recorded");
          return { status: "no-changes" };
        },
      },
      (message) => logs.push(message)
    );
    expect(logs.some((line) => line.includes(`promoted 1 pending wake(s) for ${BOARD_KEY}`))).toBe(true);
    expect(await store.sits.get(OWNER, REPO, ISSUE)).toBeUndefined();
    expect(store.rows.filter((row) => row.jobKey === keyA && row.state === "queued")).toHaveLength(1);

    const seen: IssueJob[] = [];
    let runs = 0;
    await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async (opts) => {
        runs++;
        seen.push(opts.job);
        return { status: "no-changes" };
      },
    });
    expect(runs).toBe(1);
    expect(seen[0]?.trigger).toEqual(pendingTrigger);
    const cause = await store.wakeCauses.get(keyA, "delivery:wake-1");
    expect(cause?.state).toBe("promoted");
    expect(cause?.promotedJobId).not.toBeNull();
  });

  test("unassign during the pass parks the cause cancelled and runs no further pass", async () => {
    const store = new MemoryReviewJobStore();
    const jobA = followUpJob("headsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    let runs = 0;
    const result = await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async () => {
        runs++;
        expect(
          await store.wakeCauses.record({
            jobKey: keyA,
            owner: OWNER,
            repo: REPO,
            issueNumber: ISSUE,
            prNumber: 127,
            headSha: "headsha",
            delivery: "wake-1",
            payload: wakePayload(jobA),
          })
        ).toBe("recorded");
        // Unassign lands while the pass is still running.
        await store.cancelQueuedForIssue(OWNER, REPO, ISSUE);
        return { status: "no-changes" };
      },
    });
    expect(result).toBe("processed");
    expect(runs).toBe(1);
    expect(store.rows.find((row) => row.jobKey === keyA && row.headSha === "headsha")?.state).toBe("cancelled");
    expect(await store.wakeCauses.countPending(keyA)).toBe(0);
    const parked = await store.wakeCauses.list(keyA, "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("cancelled");
    expect(store.rows.filter((row) => row.jobKey === keyA && row.state === "queued")).toHaveLength(0);
    // Nothing left to run: the parked cause never becomes a pass.
    expect(
      await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
        followUp: async () => {
          throw new Error("parked cause must not run");
        },
      })
    ).toBe("idle");
  });

  test("merge-only cause behind a normal pass runs merge-only with its stored trigger", async () => {
    const store = new MemoryReviewJobStore();
    const jobA = followUpJob("headsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const mergeTrigger = { event: "push", sender: "alice" };
    await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async () => {
        await store.wakeCauses.record({
          jobKey: keyA,
          owner: OWNER,
          repo: REPO,
          issueNumber: ISSUE,
          prNumber: 127,
          headSha: "headsha",
          delivery: "wake-merge",
          payload: wakePayload(jobA, { mergeOnly: true, trigger: mergeTrigger }),
        });
        return { status: "no-changes" };
      },
    });
    const seen: IssueJob[] = [];
    await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async (opts) => {
        seen.push(opts.job);
        return { status: "no-changes" };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mergeOnly).toBe(true);
    expect(seen[0]?.trigger).toEqual(mergeTrigger);
    expect(seen[0]?.headSha).toBe("headsha");

    // Control: the same trigger enqueued directly (un-deduped) reaches the
    // executor with the identical intent, so the promoted pass releases holds
    // exactly as a fresh event would.
    const control = new MemoryReviewJobStore();
    const controlJob = followUpJob("headsha", {
      delivery: "control-delivery",
      mergeOnly: true,
      trigger: mergeTrigger,
    });
    await control.enqueueIssue(controlJob);
    const controlSeen: IssueJob[] = [];
    await processWorkerTick(control, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async (opts) => {
        controlSeen.push(opts.job);
        return { status: "no-changes" };
      },
    });
    expect(controlSeen).toHaveLength(1);
    expect(controlSeen[0]?.trigger).toEqual(seen[0]?.trigger);
    expect(controlSeen[0]?.mergeOnly).toBe(seen[0]?.mergeOnly);
  });

  test("normal cause behind a merge-only pass runs a normal pass", async () => {
    const store = new MemoryReviewJobStore();
    const jobA = followUpJob("headsha", { mergeOnly: true });
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const normalTrigger = { event: "issue_comment", sender: "bob" };
    await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async () => {
        await store.wakeCauses.record({
          jobKey: keyA,
          owner: OWNER,
          repo: REPO,
          issueNumber: ISSUE,
          prNumber: 127,
          headSha: "headsha",
          delivery: "wake-normal",
          payload: wakePayload(jobA, { trigger: normalTrigger }),
        });
        return { status: "no-changes" };
      },
    });
    const seen: IssueJob[] = [];
    await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async (opts) => {
        seen.push(opts.job);
        return { status: "no-changes" };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mergeOnly).toBeFalsy();
    expect(seen[0]?.trigger).toEqual(normalTrigger);
  });
});
