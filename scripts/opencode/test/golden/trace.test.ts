import { describe, expect, test } from "bun:test";
import { compareObjects, normalizeString, normalizeValue, stableStringify, traced } from "./trace.ts";

describe("golden trace helpers", () => {
  test("normalizeString masks tmp paths, iso timestamps, and uuids", () => {
    expect(normalizeString("/tmp/jumi-fu-home-abc123")).toBe("<tmpdir>");
    expect(normalizeString("at 2026-11-15T10:20:30.123Z done")).toBe("at <iso> done");
    expect(normalizeString("id 123e4567-e89b-12d3-a456-426614174000 done")).toBe("id <uuid> done");
  });

  test("normalizeValue recurses and drops functions", () => {
    const value = normalizeValue({
      body: "wrote /tmp/jumi-work-xyz at 2026-11-15T10:20:30Z",
      nested: [{ pid: 12345, keep: 0 }],
      run: () => undefined,
    });
    expect(value).toEqual({
      body: "wrote <tmpdir> at <iso>",
      nested: [{ pid: "<pid>", keep: 0 }],
    });
  });

  test("stableStringify orders keys", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 1 } })).toBe(
      '{\n  "a": {\n    "c": 1,\n    "d": 2\n  },\n  "b": 1\n}\n'
    );
  });

  test("compareObjects throws a readable diff", () => {
    expect(() => compareObjects({ a: 1 }, { a: 2 }, "demo.json")).toThrow(/demo\.json mismatch/);
  });

  test("traced passes through return values", async () => {
    const add = traced("trace-self-add", (async (input: { left: number }) => ({ sum: input.left + 1 })) as (
      ...args: never[]
    ) => unknown);
    const result = await (add as unknown as (input: { left: number }) => Promise<{ sum: number }>)({ left: 1 });
    expect(result).toEqual({ sum: 2 });
  });

  test("traced rethrows and records throws", async () => {
    const failing = traced("trace-self-throw", (async () => {
      throw new Error("boom-marker");
    }) as (...args: never[]) => unknown);
    let message = "";
    try {
      await (failing as () => Promise<void>)();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("boom-marker");
  });
});
