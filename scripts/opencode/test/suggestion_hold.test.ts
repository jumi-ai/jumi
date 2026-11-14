import { describe, expect, test } from "bun:test";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import {
  markSuggestionHoldConsumed,
  readSuggestionHold,
  suggestionHoldCompletedDescription,
  suggestionHoldPendingDescription,
  suggestionHoldSkippedDescription,
} from "../src/suggestion_hold.ts";

describe("suggestion hold", () => {
  test("pending description singular and plural", () => {
    expect(suggestionHoldPendingDescription(1)).toBe("1 suggestion waiting for follow-up");
    expect(suggestionHoldPendingDescription(3)).toBe("3 suggestions waiting for follow-up");
  });

  test("completed and skipped descriptions carry the count and reason", () => {
    expect(suggestionHoldCompletedDescription(2)).toBe("2 suggestions (follow-up completed)");
    expect(suggestionHoldSkippedDescription(1, "round cap")).toBe("1 suggestion (follow-up skipped: round cap)");
  });

  test("latch starts empty, marks consumed once, and survives the round fields", async () => {
    const store = new MemorySkipLatchStore();
    const key = { owner: "o", repo: "r", issueNumber: 7 };
    expect((await readSuggestionHold(store, key)).consumed).toBeUndefined();
    await markSuggestionHoldConsumed(store, key, "ABC123", 2);
    const hold = await readSuggestionHold(store, key);
    expect(hold).toMatchObject({ consumed: true, headSha: "abc123", count: 2 });
  });
});
