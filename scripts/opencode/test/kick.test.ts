import { describe, expect, test } from "bun:test";
import {
  failingVerdictReasonFromMarkdown,
  isFailingVerdictRow,
  isKickableReviewRow,
  kickReasonOf,
} from "../src/kick.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";

const PATCH = ["@@ -1,3 +1,5 @@", " context", "-old", "+new line two", "+new line three", " context", " tail"].join(
  "\n"
);

function makeStore(): ReviewVerdictStore {
  return new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
}

describe("kick verdict view", () => {
  test("failure verdict: a row with a record matches the row without one", () => {
    const store = makeStore();
    expect(
      store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." }).ok
    ).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "1 blocking" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const record = store.toRecord();

    expect(failingVerdictReasonFromMarkdown(markdown)).toBe("1 blocking");
    expect(failingVerdictReasonFromMarkdown(markdown, record)).toBe(failingVerdictReasonFromMarkdown(markdown));
    const base = { state: "succeeded", resultReason: null, error: null, resultMarkdown: markdown } as const;
    expect(isFailingVerdictRow({ ...base })).toBe(true);
    expect(isFailingVerdictRow({ ...base, resultJson: record })).toBe(true);
    expect(kickReasonOf({ ...base })).toBe("1 blocking");
    expect(kickReasonOf({ ...base, resultJson: record })).toBe(kickReasonOf({ ...base }));
    expect(isKickableReviewRow({ ...base })).toBe(true);
    expect(isKickableReviewRow({ ...base, resultJson: record })).toBe(true);
  });

  test("success verdict: a row with a record matches the row without one", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success", reason: "2 suggestions" }).ok).toBe(true);
    const markdown = store.toMarkdown();
    const record = store.toRecord();

    expect(failingVerdictReasonFromMarkdown(markdown)).toBeUndefined();
    expect(failingVerdictReasonFromMarkdown(markdown, record)).toBeUndefined();
    const base = { state: "succeeded", resultReason: null, error: null, resultMarkdown: markdown } as const;
    expect(isFailingVerdictRow({ ...base })).toBe(false);
    expect(isFailingVerdictRow({ ...base, resultJson: record })).toBe(false);
    expect(kickReasonOf({ ...base })).toBe("");
    expect(kickReasonOf({ ...base, resultJson: record })).toBe("");
    expect(isKickableReviewRow({ ...base })).toBe(false);
    expect(isKickableReviewRow({ ...base, resultJson: record })).toBe(false);
  });

  test("no-verdict store row: a row with a record matches the row without one", () => {
    const store = makeStore();
    expect(store.addFinding({ path: "src/a.ts", line: 2, severity: "risk", title: "race", body: "Guard it." }).ok).toBe(
      true
    );
    const markdown = store.toMarkdown();
    const record = store.toRecord();

    expect(failingVerdictReasonFromMarkdown(markdown)).toBe("Incomplete review: no verdict");
    expect(failingVerdictReasonFromMarkdown(markdown, record)).toBe(failingVerdictReasonFromMarkdown(markdown));
    const base = { state: "succeeded", resultReason: null, error: null, resultMarkdown: markdown } as const;
    expect(isFailingVerdictRow({ ...base })).toBe(true);
    expect(isFailingVerdictRow({ ...base, resultJson: record })).toBe(true);
    expect(kickReasonOf({ ...base, resultJson: record })).toBe(kickReasonOf({ ...base }));
  });

  test("failed rows use the publish reason with or without a record", () => {
    const store = makeStore();
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    const record = store.toRecord();
    const base = {
      state: "failed",
      resultReason: "boom",
      error: null,
      resultMarkdown: store.toMarkdown(),
    } as const;
    expect(kickReasonOf({ ...base })).toBe("boom");
    expect(kickReasonOf({ ...base, resultJson: record })).toBe("boom");
  });
});
