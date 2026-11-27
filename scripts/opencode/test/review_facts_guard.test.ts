import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guard for the review-facts seam: `review_facts.ts` is the only module that
// may call the legacy text parsers in `verdict.ts`. Every consumer of a
// published review (hold/wake, handover, carry, latch inputs) reads the facts
// value instead. Publication counting (`review.ts`) and the other
// record/store/grouping helpers intentionally keep their direct `verdict.ts`
// use and are not consumers in this sense.

const SRC = join(import.meta.dir, "..", "src");

// Consumers that must read facts, never the legacy parsers.
const CONSUMERS = [
  "followup.ts",
  "hold_settlement.ts",
  "hold_resolve.ts",
  "handover.ts",
  "review_carry.ts",
  "review_delta.ts",
  "stuck.ts",
  "pr_snapshot.ts",
];

// Consumers rewritten onto the facts module (pr_snapshot reads facts through
// the stuck latch helpers, so it needs no direct import).
const FACTS_READERS = [
  "followup.ts",
  "hold_settlement.ts",
  "hold_resolve.ts",
  "handover.ts",
  "review_carry.ts",
  "review_delta.ts",
  "stuck.ts",
];

function readSrc(file: string): string {
  return readFileSync(join(SRC, file), "utf8");
}

describe("review facts seam guard", () => {
  test("no consumer imports the legacy verdict parsers", () => {
    for (const file of CONSUMERS) {
      expect(readSrc(file)).not.toMatch(/from ["']\.\/verdict\.ts["']/);
    }
  });

  test("the classifier owns the legacy verdict imports", () => {
    expect(readSrc("review_facts.ts")).toMatch(/from ["']\.\/verdict\.ts["']/);
  });

  test("consumers read the facts module", () => {
    for (const file of FACTS_READERS) {
      expect(readSrc(file)).toMatch(/from ["']\.\/review_facts\.ts["']/);
    }
  });
});
