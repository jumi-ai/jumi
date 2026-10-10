import { describe, expect, test } from "bun:test";
import { MemoryProvenanceStore, mergeContributors, ProvenanceCollector } from "../src/provenance.ts";

const CLAUDE_OPUS = { type: "claude", model: "claude-opus-5", effort: "high" };
const OPENCODE_GROK = { type: "opencode", model: "xai/grok-4.6", variant: "high" };

describe("mergeContributors", () => {
  test("dedupes by type/model/level and preserves first-seen order", () => {
    const merged = mergeContributors([CLAUDE_OPUS], [OPENCODE_GROK, CLAUDE_OPUS]);
    expect(merged).toEqual([CLAUDE_OPUS, OPENCODE_GROK]);
  });

  test("drops empty identities", () => {
    expect(mergeContributors([], [{ type: "", model: "" }])).toEqual([]);
  });
});

describe("ProvenanceCollector", () => {
  test("post-hop publish includes the earlier failed runner", () => {
    const chain = [
      { name: "primary", type: "claude" as const, model: "claude-opus-5", effort: "high" },
      { name: "fallback", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" },
    ];
    const collector = new ProvenanceCollector(chain);
    collector.noteRunner({ type: "opencode", model: "xai/grok-4.6", variant: "high" }, 1);
    expect(collector.getContributors()).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);
    expect(collector.getPublisher()).toEqual({ type: "opencode", model: "xai/grok-4.6", variant: "high" });
  });

  test("failed runner error is retained for conservative attribution", () => {
    const collector = new ProvenanceCollector();
    const err = Object.assign(new Error("provider unavailable"), {
      runner: { ...CLAUDE_OPUS },
      chainIndex: 0,
    });
    collector.noteError(err);
    collector.noteRunner({ ...OPENCODE_GROK });
    expect(collector.getContributors()).toEqual([CLAUDE_OPUS, OPENCODE_GROK]);
  });
});

describe("MemoryProvenanceStore", () => {
  test("claude/opus and opencode/grok implements are looked up by exact head", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "aaa111",
      contributors: [CLAUDE_OPUS],
      publisher: CLAUDE_OPUS,
      jobId: 1,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d1",
      jobKind: "implement",
    });
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 8,
      branch: "jumi/issue-13-b",
      headSha: "bbb222",
      contributors: [OPENCODE_GROK],
      publisher: OPENCODE_GROK,
      jobId: 2,
      jobKey: "implement:kirmanak/demo#13",
      delivery: "d2",
      jobKind: "implement",
    });
    const claude = await store.lookupByHead("gitea", "kirmanak", "demo", "aaa111");
    expect(claude.status).toBe("known");
    expect(claude.contributors).toEqual([CLAUDE_OPUS]);
    expect(claude.publisher).toEqual(CLAUDE_OPUS);
    const grok = await store.lookupByHead("gitea", "kirmanak", "demo", "bbb222");
    expect(grok.status).toBe("known");
    expect(grok.contributors).toEqual([OPENCODE_GROK]);
  });

  test("follow-up preserves earlier contributors and adds the new writer", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head1",
      contributors: [CLAUDE_OPUS],
      publisher: CLAUDE_OPUS,
      jobId: 1,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d1",
      jobKind: "implement",
    });
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head2",
      contributors: [OPENCODE_GROK],
      publisher: OPENCODE_GROK,
      jobId: 3,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      delivery: "d3",
      jobKind: "follow-up",
    });
    const lookup = await store.lookupByHead("gitea", "kirmanak", "demo", "head2");
    expect(lookup.status).toBe("known");
    expect(lookup.contributors).toEqual([CLAUDE_OPUS, OPENCODE_GROK]);
    expect(lookup.publisher).toEqual(OPENCODE_GROK);
  });

  test("changing PR prose cannot alter the lookup", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head1",
      contributors: [CLAUDE_OPUS],
      publisher: CLAUDE_OPUS,
      jobId: 1,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d1",
      jobKind: "implement",
    });
    const before = await store.lookupByHead("gitea", "kirmanak", "demo", "head1");
    // The store never reads PR bodies or stamps: no API here takes prose.
    const after = await store.lookupByHead("gitea", "kirmanak", "demo", "head1");
    expect(after).toEqual(before);
  });

  test("publish-before-review returns pending until confirmed", async () => {
    const store = new MemoryProvenanceStore();
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 7,
      branch: "jumi/issue-12-a",
      jobId: 10,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      jobKind: "follow-up",
      delivery: "d10",
    });
    const pending = await store.lookupForReview({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "head2",
      branch: "jumi/issue-12-a",
    });
    expect(pending.status).toBe("pending");
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head2",
      contributors: [OPENCODE_GROK],
      publisher: OPENCODE_GROK,
      jobId: 10,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      delivery: "d10",
      jobKind: "follow-up",
    });
    const known = await store.lookupForReview({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "head2",
      branch: "jumi/issue-12-a",
    });
    expect(known.status).toBe("known");
  });

  test("moved heads are never described by an earlier head record", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head1",
      contributors: [CLAUDE_OPUS],
      publisher: CLAUDE_OPUS,
      jobId: 1,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d1",
      jobKind: "implement",
    });
    const moved = await store.lookupByHead("gitea", "kirmanak", "demo", "head2");
    expect(moved.status).toBe("unknown");
    const review = await store.lookupForReview({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "head2",
      branch: "jumi/issue-12-a",
    });
    expect(review.status).toBe("unknown");
  });

  test("duplicate intents and confirms are idempotent", async () => {
    const store = new MemoryProvenanceStore();
    const first = await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 0,
      branch: "jumi/issue-12-a",
      jobId: 21,
      jobKey: "implement:kirmanak/demo#12",
      jobKind: "implement",
      delivery: "d1",
    });
    const second = await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 0,
      branch: "jumi/issue-12-a",
      jobId: 21,
      jobKey: "implement:kirmanak/demo#12",
      jobKind: "implement",
      delivery: "d1-retry",
    });
    expect(second.id).toBe(first.id);
    const input = {
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      branch: "jumi/issue-12-a",
      headSha: "head9",
      contributors: [CLAUDE_OPUS],
      publisher: CLAUDE_OPUS,
      jobId: 21,
      jobKey: "implement:kirmanak/demo#12",
      delivery: "d1",
      jobKind: "implement",
    };
    await store.confirmPublication(input);
    await store.confirmPublication(input);
    expect(
      (await store.listByPr("gitea", "kirmanak", "demo", 7)).filter((row) => row.headSha === "head9")
    ).toHaveLength(1);
  });

  test("failed publication never looks confirmed", async () => {
    const store = new MemoryProvenanceStore();
    await store.ensureIntent({
      forge: "gitea",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 7,
      branch: "jumi/issue-12-a",
      jobId: 31,
      jobKey: "follow-up:kirmanak/demo#7:head1",
      jobKind: "follow-up",
      delivery: "d31",
    });
    await store.markIntentFailed(31, "push rejected", "headX");
    expect((await store.lookupByHead("gitea", "kirmanak", "demo", "headX")).status).toBe("unknown");
    expect(
      (
        await store.lookupForReview({
          forge: "gitea",
          owner: "kirmanak",
          repo: "demo",
          prNumber: 7,
          headSha: "headX",
          branch: "jumi/issue-12-a",
        })
      ).status
    ).toBe("failed");
  });

  test("legacy heads without rows stay unknown", async () => {
    const store = new MemoryProvenanceStore();
    expect((await store.lookupByHead("gitea", "kirmanak", "demo", "legacy")).status).toBe("unknown");
  });
});
