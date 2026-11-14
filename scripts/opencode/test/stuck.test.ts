import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoardGroups } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { normalizeSitReason } from "../src/router_sits.ts";
import {
  appendStuckFingerprint,
  blockingFindingIdentities,
  detectStuck,
  evaluateStuck,
  fingerprintCiChecks,
  fingerprintError,
  fingerprintFindingIdentity,
  fingerprintFindingIdentityFromParts,
  fingerprintFollowUpText,
  fingerprintPrDiffFromFiles,
  fingerprintReviewArtifact,
  fingerprintSameFinding,
  isSkipLatchReason,
  readStuckState,
  SAME_FINDING_STUCK,
  sameFindingDisplayFromParts,
  sameFindingLatchReasonFromParts,
  stuckComment,
  writeStuckState,
} from "../src/stuck.ts";

const findingA = "please fix the tests\n<!-- jumi-check: failure -->";
const findingB = "rename the helper\n<!-- jumi-check: failure -->";

describe("fingerprintReviewArtifact", () => {
  test("hashes a complete failure finding and ignores commit SHA", () => {
    const a = fingerprintReviewArtifact(
      "### Jumi review\n\nReviewed commit: `abc1234`\n\nplease fix the tests\n<!-- jumi-check: failure -->"
    );
    const b = fingerprintReviewArtifact(
      "### Jumi review\n\nReviewed commit: `def5678`\n\nplease fix the tests\n<!-- jumi-check: failure -->"
    );
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  test("does not count empty, incomplete, stub, or success artifacts", () => {
    expect(fingerprintReviewArtifact("")).toBeUndefined();
    expect(fingerprintReviewArtifact(undefined)).toBeUndefined();
    expect(fingerprintReviewArtifact("please fix the tests")).toBeUndefined();
    expect(fingerprintReviewArtifact("I'll inspect the PR and check for correctness issues.")).toBeUndefined();
    expect(fingerprintReviewArtifact("Looks good\n<!-- jumi-check: success -->")).toBeUndefined();
    expect(fingerprintReviewArtifact("<!-- jumi-check: failure -->")).toBeUndefined();
  });
});

describe("fingerprintFollowUpText", () => {
  test("strips SHAs, ids, and headers so the same finding matches", () => {
    const a = fingerprintFollowUpText(`# Review feedback

PR: https://gitea.kirmanak.stream/kirmanak/demo/pulls/127
Number: 127
Head SHA: abcdef1
Head ref: jumi/issue-12-fix

## Trigger

Event: issue_comment
Sender: alice
Comment id: 55

please fix the tests
`);
    const b = fingerprintFollowUpText(`# Review feedback

PR: https://gitea.kirmanak.stream/kirmanak/demo/pulls/127
Number: 127
Head SHA: 9999999
Head ref: jumi/issue-12-fix

## Trigger

Event: issue_comment
Sender: alice
Comment id: 55

please fix the tests
`);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  test("does not count empty or boilerplate feedback", () => {
    expect(fingerprintFollowUpText("")).toBeUndefined();
    expect(fingerprintFollowUpText("# Review feedback\n\n(no trigger body)\n")).toBeUndefined();
    expect(
      fingerprintFollowUpText("# Review feedback\n\nNo review comments this round. Address JUMI_CI.md.\n")
    ).toBeUndefined();
  });
});

describe("fingerprintError", () => {
  test("hashes a job error and skips cancel/empty", () => {
    expect(fingerprintError("opencode exploded")).toBeTruthy();
    expect(fingerprintError("opencode exploded")).toBe(fingerprintError("  opencode exploded  "));
    expect(fingerprintError("")).toBeUndefined();
    expect(fingerprintError("cancelled")).toBeUndefined();
    expect(fingerprintError("AbortError")).toBeUndefined();
  });
});

describe("fingerprintCiChecks", () => {
  test("requires a log hash", () => {
    expect(fingerprintCiChecks([{ name: "build", logHash: "" }])).toBeUndefined();
    expect(fingerprintCiChecks([{ name: "build", logHash: "abc" }])).toBeTruthy();
  });
});

describe("detectStuck", () => {
  const A = { kind: "action" as const, hash: "aaa" };
  const B = { kind: "action" as const, hash: "bbb" };
  const C = { kind: "ci" as const, hash: "ccc" };
  const D = { kind: "ci" as const, hash: "ddd" };
  const E = { kind: "error" as const, hash: "eee" };
  const F = { kind: "error" as const, hash: "fff" };

  test("same action 4×", () => {
    expect(detectStuck([A, A, A])).toBeUndefined();
    expect(detectStuck([A, A, A, A])).toBe("repeated-action");
  });

  test("same CI 4×", () => {
    expect(detectStuck([C, C, C])).toBeUndefined();
    expect(detectStuck([C, C, C, C])).toBe("repeated-action");
  });

  test("same error 3×", () => {
    expect(detectStuck([E, E])).toBeUndefined();
    expect(detectStuck([E, E, E])).toBe("repeated-error");
  });

  test("A→B→A ping-pong of distinct fingerprints", () => {
    expect(detectStuck([A, B])).toBeUndefined();
    expect(detectStuck([A, B, A])).toBe("ping-pong");
    expect(detectStuck([C, D, C])).toBe("ping-pong");
    expect(detectStuck([E, F, E])).toBe("ping-pong");
  });

  test("two different reviews without alternating are not ping-pong", () => {
    expect(detectStuck([A, B, B])).toBeUndefined();
    expect(detectStuck([A, A, B])).toBeUndefined();
  });

  test("mixed kinds last-three is not ping-pong", () => {
    expect(detectStuck([A, E, A])).toBeUndefined();
    expect(evaluateStuck([A, E], A)).toBeUndefined();
    expect(detectStuck([A, C, A])).toBeUndefined();
    expect(evaluateStuck([A, C], A)).toBeUndefined();
  });

  test("evaluateStuck uses current fingerprint", () => {
    expect(evaluateStuck([A, A, A], A)).toBe("repeated-action");
    expect(evaluateStuck([A, B], A)).toBe("ping-pong");
    expect(evaluateStuck([C, C, C], C)).toBe("repeated-action");
    expect(evaluateStuck([C, D], C)).toBe("ping-pong");
    expect(evaluateStuck([E, E], E)).toBe("repeated-error");
    expect(evaluateStuck([A, A], B)).toBeUndefined();
  });

  test("stays stuck once the history already matches", () => {
    expect(evaluateStuck([A, B, A], B)).toBe("ping-pong");
  });
});

describe("stuckComment", () => {
  test("uses stuck: prefix", () => {
    expect(stuckComment("repeated-action")).toBe("stuck: repeated action");
    expect(stuckComment("repeated-error")).toBe("stuck: repeated error");
    expect(stuckComment("ping-pong")).toBe("stuck: ping-pong");
    expect(stuckComment("same-finding")).toBe(SAME_FINDING_STUCK);
  });
});

describe("isSkipLatchReason", () => {
  test("matches stuck: skip latches and ignores per-job skips", () => {
    expect(isSkipLatchReason("stuck: cannot resolve conflicts")).toBe(true);
    expect(isSkipLatchReason("stuck: repeated error")).toBe(true);
    expect(isSkipLatchReason("stuck: usage limit exceeded")).toBe(true);
    expect(isSkipLatchReason("same head and base already attempted")).toBe(false);
    expect(isSkipLatchReason("no unhandled feedback")).toBe(false);
    expect(isSkipLatchReason(undefined)).toBe(false);
  });
});

describe("stuck state file", () => {
  test("round-trips fingerprints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-stuck-"));
    try {
      const path = join(dir, "12.stuck.json");
      await writeStuckState(path, {
        fingerprints: [{ kind: "action", hash: fingerprintReviewArtifact(findingA)! }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      await appendStuckFingerprint(path, { kind: "action", hash: fingerprintReviewArtifact(findingB)! });
      await appendStuckFingerprint(path, {
        kind: "ci",
        hash: fingerprintCiChecks([{ name: "build", logHash: "abc" }])!,
      });
      const state = await readStuckState(path);
      expect(state.fingerprints).toHaveLength(3);
      expect(state.fingerprints[0]?.kind).toBe("action");
      expect(state.fingerprints[2]?.kind).toBe("ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("same finding repeated", () => {
  const reviewOne = "src/foo.ts:123: 🟡 risk: Null check missing for bar.\n\n<!-- jumi-check: failure -->";
  const reviewTwo =
    "src/foo.ts:124: 🟡 risk: Missing null check for bar! Re-checked on this head abc1234, still present.\n\n<!-- jumi-check: failure -->";
  const reviewThree =
    "src/foo.ts:123: 🟡 risk: bar null check missing. Re-checked after base merge def5678.\n\n<!-- jumi-check: failure -->";
  const otherFinding = "src/foo.ts:123: 🟡 risk: Race condition in cache.\n\n<!-- jumi-check: failure -->";
  const diffA = [{ filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }];
  const diffB = [{ filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+fixed" }];

  function combined(review: string, diffHash: string): { kind: "finding"; hash: string } {
    const findingHash = fingerprintFindingIdentity(review)!;
    expect(findingHash).toBeTruthy();
    return { kind: "finding", hash: fingerprintSameFinding(findingHash, diffHash) };
  }

  test("reworded finding keeps the same identity across nearby lines", () => {
    expect(blockingFindingIdentities(reviewOne)).toHaveLength(1);
    expect(fingerprintFindingIdentity(reviewOne)).toBe(fingerprintFindingIdentity(reviewTwo));
    expect(fingerprintFindingIdentity(reviewOne)).toBe(fingerprintFindingIdentity(reviewThree));
    expect(fingerprintFindingIdentity(reviewOne)).not.toBe(fingerprintFindingIdentity(otherFinding));
  });

  test("three reviews with the same identity on an unchanged diff are stuck", () => {
    const diffHash = fingerprintPrDiffFromFiles(diffA)!;
    const one = combined(reviewOne, diffHash);
    const two = combined(reviewTwo, diffHash);
    const three = combined(reviewThree, diffHash);
    expect(one.hash).toBe(two.hash);
    expect(two.hash).toBe(three.hash);
    expect(detectStuck([one, two])).toBeUndefined();
    expect(detectStuck([one, two, three])).toBe("same-finding");
    expect(evaluateStuck([one, two], three)).toBe("same-finding");
  });

  test("a real change to the PR diff resets the count", () => {
    const before = fingerprintPrDiffFromFiles(diffA)!;
    const after = fingerprintPrDiffFromFiles(diffB)!;
    expect(before).not.toBe(after);
    const one = combined(reviewOne, before);
    const two = combined(reviewTwo, before);
    const changed = combined(reviewThree, after);
    expect(changed.hash).not.toBe(one.hash);
    expect(evaluateStuck([one, two], changed)).toBeUndefined();
  });

  test("a different finding does not trip", () => {
    const diffHash = fingerprintPrDiffFromFiles(diffA)!;
    const one = combined(reviewOne, diffHash);
    const two = combined(reviewTwo, diffHash);
    const otherHash = fingerprintFindingIdentity(otherFinding)!;
    const other = { kind: "finding" as const, hash: fingerprintSameFinding(otherHash, diffHash) };
    expect(other.hash).not.toBe(one.hash);
    expect(evaluateStuck([one, two], other)).toBeUndefined();
  });

  test("suggestions do not count as blocking findings", () => {
    const suggestion = "src/foo.ts:123: 💡 suggestion: Rename this helper.\n\n<!-- jumi-check: failure -->";
    expect(blockingFindingIdentities(suggestion)).toEqual([]);
    expect(fingerprintFindingIdentity(suggestion)).toBeUndefined();
  });

  test("inline findings feed the same identity", () => {
    const inlineBody = "🟡 risk: Null check missing for bar. Re-checked on this head abc1234.";
    const fromBody = fingerprintFindingIdentity(reviewOne)!;
    const fromParts = fingerprintFindingIdentityFromParts(undefined, [
      { path: "src/foo.ts", new_position: 124, body: inlineBody },
    ])!;
    expect(fromParts).toBe(fromBody);
  });

  test("inline-only identity works with an empty review body", () => {
    expect(fingerprintFindingIdentityFromParts("", [])).toBeUndefined();
    expect(fingerprintFindingIdentityFromParts(undefined, undefined)).toBeUndefined();
    const inlineOnly = fingerprintFindingIdentityFromParts("", [
      { path: "src/foo.ts", new_position: 124, body: "🟡 risk: Null check missing for bar." },
    ]);
    expect(inlineOnly).toBe(fingerprintFindingIdentity(reviewOne));
  });

  test("diff metadata changes the hash and all-omitted patches fail open", () => {
    const base = [{ filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }];
    const renamed = [{ filename: "src/foo.ts", status: "renamed", patch: "@@ -1 +1 @@\n-old\n+new" }];
    expect(fingerprintPrDiffFromFiles(renamed)).not.toBe(fingerprintPrDiffFromFiles(base));
    const grown = [
      { filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, changes: 2 },
      { filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 10, deletions: 1, changes: 11 },
    ];
    expect(fingerprintPrDiffFromFiles([grown[0]!])).not.toBe(fingerprintPrDiffFromFiles([grown[1]!]));
    expect(fingerprintPrDiffFromFiles([{ filename: "src/big.bin" }])).toBeUndefined();
    expect(
      fingerprintPrDiffFromFiles([{ filename: "src/big.bin" }, { filename: "src/other.bin", patch: null }])
    ).toBeUndefined();
    // Omitted patch is not the same as an empty patch.
    expect(fingerprintPrDiffFromFiles([{ filename: "src/foo.ts", patch: "" }])).not.toBe(
      fingerprintPrDiffFromFiles([{ filename: "src/foo.ts" }])
    );
    // A partially-omitted diff still hashes (only all-omitted fails open).
    expect(
      fingerprintPrDiffFromFiles([
        { filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
        { filename: "src/big.bin" },
      ])
    ).toBeTruthy();
  });

  test("same-finding latch maps to an implement-latch sit and shows on the board", async () => {
    const latchReason = sameFindingLatchReasonFromParts(reviewOne, []);
    expect(latchReason.startsWith(SAME_FINDING_STUCK)).toBe(true);
    expect(normalizeSitReason(latchReason)).toBe("implement-latch");
    expect(normalizeSitReason("stuck: too many follow-up rounds")).toBe("implement-latch");

    const store = new MemoryReviewJobStore();
    await store.sits.remember("kirmanak", "demo", 12, "implement-latch");
    await store.setIssueSkipReason("kirmanak", "demo", 12, latchReason);
    const groups = await buildBoardGroups(store);
    const item = groups.needs_kick.find((entry) => entry.number === 12);
    expect(item).toBeDefined();
    expect(item?.kick?.kick).toBe("stuck");
    expect(item?.message).toContain(SAME_FINDING_STUCK);
    expect(item?.message).toContain("src/foo.ts");
    const display = sameFindingDisplayFromParts(reviewOne, []);
    expect(item?.message).toContain(display!.slice(0, 20));
  });
});
