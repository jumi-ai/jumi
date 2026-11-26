import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineFilePath, countLines, readLineCounts, renderBaseline } from "../src/regenerate_file_size_baseline.ts";

const srcDir = join(process.cwd(), "src");

describe("file-size baseline freshness", () => {
  test("the committed baseline matches the regenerated one", () => {
    const committed = readFileSync(baselineFilePath(), "utf8");
    expect(committed).toBe(renderBaseline(readLineCounts(srcDir)));
  });

  test("boundary: trailing newline counting matches the ratchet", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  test("rendering sorts keys with one trailing newline", () => {
    expect(renderBaseline({ "b.ts": 2, "a.ts": 1 })).toBe('{\n  "a.ts": 1,\n  "b.ts": 2\n}\n');
  });
});
