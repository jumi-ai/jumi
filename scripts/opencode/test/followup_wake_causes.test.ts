import { describe, expect, test } from "bun:test";
import {
  canonicalizeWakeCauseValue,
  canonicalWakeCauseJson,
  type FollowUpWakeCauseInput,
  MemoryFollowUpWakeCauseStore,
  payloadDigestForWakeCause,
  resolveFollowUpWakeCauseId,
  webhookWakeDeliveryFallback,
} from "../src/followup_wake_causes.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";

function payload(generation: number, trigger = "issue_comment"): Record<string, unknown> {
  return {
    issueNumber: 12,
    title: "Fix",
    body: "body",
    htmlUrl: "https://example.test/o/r/issues/12",
    issueUpdatedAt: "2026-05-23T00:00:00Z",
    defaultBranch: "main",
    cloneUrl: "https://example.test/o/r.git",
    action: "created",
    trigger: { event: trigger, sender: "alice" },
    generation,
  };
}

function input(overrides: Partial<FollowUpWakeCauseInput> = {}): FollowUpWakeCauseInput {
  return {
    jobKey: "follow-up:o/r#12:head-1",
    owner: "o",
    repo: "r",
    issueNumber: 12,
    prNumber: 100,
    headSha: "head-1",
    delivery: "delivery-1",
    payload: payload(0),
    ...overrides,
  };
}

describe("follow-up wake-cause identity", () => {
  test("explicit stable identity wins over delivery and payload", () => {
    expect(resolveFollowUpWakeCauseId({ causeId: "  src:1 ", delivery: "d", payload: payload(0) })).toBe("src:1");
  });

  test("non-empty delivery maps to delivery: prefix", () => {
    expect(resolveFollowUpWakeCauseId({ delivery: "abc-123", payload: payload(0) })).toBe("delivery:abc-123");
  });

  test("empty delivery falls through to the payload digest", () => {
    const id = resolveFollowUpWakeCauseId({ delivery: "   ", payload: payload(0) });
    expect(id).toBe(`payload-sha256:${payloadDigestForWakeCause(payload(0))}`);
  });

  test("same payload and generation is a replay; changed payload or new generation is distinct", () => {
    const a = resolveFollowUpWakeCauseId({ payload: payload(0) });
    expect(resolveFollowUpWakeCauseId({ payload: payload(0) })).toBe(a);
    expect(resolveFollowUpWakeCauseId({ payload: payload(1) })).not.toBe(a);
    expect(
      resolveFollowUpWakeCauseId({ payload: { ...payload(0), trigger: { event: "push", sender: "b" } } })
    ).not.toBe(a);
  });

  test("key order is irrelevant to the digest", () => {
    const a = { b: 1, a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, b: 1 };
    expect(canonicalWakeCauseJson(a)).toBe(canonicalWakeCauseJson(b));
    expect(canonicalizeWakeCauseValue(a)).toEqual({ a: { x: 1, y: 2 }, b: 1 });
    expect(resolveFollowUpWakeCauseId({ payload: { ...payload(0), extra: a } })).toBe(
      resolveFollowUpWakeCauseId({ payload: { ...payload(0), extra: b } })
    );
  });

  test("missing generation digests as generation zero", () => {
    const { generation: _dropped, ...noGeneration } = payload(0);
    void _dropped;
    expect(resolveFollowUpWakeCauseId({ payload: noGeneration })).toBe(
      resolveFollowUpWakeCauseId({ payload: { ...noGeneration, generation: 0 } })
    );
  });

  test("no identity source throws", () => {
    expect(() => resolveFollowUpWakeCauseId({})).toThrow();
  });

  test("webhook fallback is a stable family-namespaced body digest, never random", () => {
    const first = webhookWakeDeliveryFallback("issue_comment", "raw-body-1");
    expect(first).toBe(webhookWakeDeliveryFallback(" issue_COMMENT ", "raw-body-1"));
    expect(first.startsWith("issue-comment-sha256:")).toBe(true);
    expect(webhookWakeDeliveryFallback("issue_comment", "raw-body-2")).not.toBe(first);
    expect(webhookWakeDeliveryFallback("push", "raw-body-1")).not.toBe(first);
    expect(first).not.toContain("delivery:delivery");
  });
});

describe("MemoryFollowUpWakeCauseStore", () => {
  test("record round-trips the exact payload", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    const body = payload(3);
    expect(await store.record(input({ payload: body }))).toBe("recorded");
    const cause = await store.get("follow-up:o/r#12:head-1", "delivery:delivery-1");
    expect(cause).toBeDefined();
    expect(cause?.payload).toEqual(body);
    expect(cause?.state).toBe("pending");
    expect(cause?.parkReason).toBeNull();
    expect(cause?.promotedJobId).toBeNull();
    expect(cause?.settledAtMs).toBeNull();
  });

  test("duplicate in pending state", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    expect(await store.record(input())).toBe("recorded");
    expect(await store.record(input())).toBe("duplicate");
    expect(await store.countPending("follow-up:o/r#12:head-1")).toBe(1);
  });

  test("duplicate after promotion keeps identity", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    expect(await store.record(input())).toBe("recorded");
    const pending = await store.peekOldestPending("follow-up:o/r#12:head-1");
    expect(pending).toBeDefined();
    expect(await store.markPromoted(pending?.id ?? 0, 77)).toBe(true);
    expect(await store.record(input())).toBe("duplicate");
    const promoted = await store.get("follow-up:o/r#12:head-1", "delivery:delivery-1");
    expect(promoted?.state).toBe("promoted");
    expect(promoted?.promotedJobId).toBe(77);
    expect(promoted?.settledAtMs).not.toBeNull();
  });

  test("duplicate after park keeps the row listable with its reason", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    expect(await store.record(input())).toBe("recorded");
    expect(await store.parkPendingForKey("follow-up:o/r#12:head-1", "stale")).toBe(1);
    expect(await store.record(input())).toBe("duplicate");
    const parked = await store.list("follow-up:o/r#12:head-1", "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("stale");
    expect(parked[0]?.state).toBe("parked");
  });

  test("promotion only changes state, park_reason, promoted_job_id, settled_at", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    const body = payload(0);
    await store.record(input({ payload: body }));
    const before = await store.get("follow-up:o/r#12:head-1", "delivery:delivery-1");
    await store.markPromoted(before?.id ?? 0, 9);
    const after = await store.get("follow-up:o/r#12:head-1", "delivery:delivery-1");
    expect(after?.payload).toEqual(body);
    expect(after?.payload).toEqual(before?.payload);
    expect(after?.parkReason).toBeNull();
    expect(after?.promotedJobId).toBe(9);
    expect(after?.createdAtMs).toBe(before?.createdAtMs);
  });

  test("markPromoted on a settled row returns false", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    await store.record(input());
    const pending = await store.peekOldestPending("follow-up:o/r#12:head-1");
    expect(await store.markPromoted(pending?.id ?? 0, 1)).toBe(true);
    expect(await store.markPromoted(pending?.id ?? 0, 2)).toBe(false);
    expect(await store.markPromoted(999_999, 2)).toBe(false);
  });

  test("oldest-first peek across causes", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    await store.record(input({ delivery: "second" }));
    await store.record(input({ delivery: "first" }));
    await store.record(input({ delivery: "third" }));
    const peeked = await store.peekOldestPending("follow-up:o/r#12:head-1");
    expect(peeked?.causeId).toBe("delivery:second");
    expect(await store.peekOldestPending("unknown-key")).toBeUndefined();
  });

  test("generation-filtered park preserves later valid causes", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    await store.record(input({ jobKey: "k", delivery: "old", payload: payload(0) }));
    await store.record(input({ jobKey: "k", delivery: "current", payload: payload(2) }));
    await store.record(input({ jobKey: "k", delivery: "newer", payload: payload(5) }));
    expect(await store.parkPendingForKey("k", "superseded", { generation: 2 })).toBe(1);
    expect(await store.countPending("k")).toBe(2);
    expect((await store.get("k", "delivery:old"))?.state).toBe("parked");
    expect((await store.get("k", "delivery:current"))?.state).toBe("pending");
    expect((await store.get("k", "delivery:newer"))?.state).toBe("pending");
  });

  test("park by issue filters on owner, repo, and issue", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    await store.record(input({ jobKey: "k1", delivery: "a" }));
    await store.record(input({ jobKey: "k2", owner: "other", delivery: "b" }));
    expect(await store.parkPendingForIssue("o", "r", 12, "cancelled")).toBe(1);
    expect((await store.get("k1", "delivery:a"))?.state).toBe("parked");
    expect((await store.get("k2", "delivery:b"))?.state).toBe("pending");
  });

  test("no row is ever deleted: 1000 records all persist with no cap", async () => {
    const store = new MemoryFollowUpWakeCauseStore();
    for (let i = 0; i < 1000; i++) {
      expect(await store.record(input({ delivery: `d-${i}` }))).toBe("recorded");
    }
    expect(await store.countPending("follow-up:o/r#12:head-1")).toBe(1000);
    expect((await store.list("follow-up:o/r#12:head-1")).length).toBe(1000);
  });

  test("wake causes are exposed on the memory review job store", async () => {
    const jobs = new MemoryReviewJobStore();
    expect(await jobs.wakeCauses.record(input())).toBe("recorded");
    expect(await jobs.wakeCauses.countPending("follow-up:o/r#12:head-1")).toBe(1);
  });
});
