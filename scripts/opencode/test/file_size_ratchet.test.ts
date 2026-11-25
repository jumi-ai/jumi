import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLineCounts } from "../src/regenerate_file_size_baseline.ts";

const repoRoot = join(process.cwd(), "../..");
const srcDir = join(repoRoot, "scripts", "opencode", "src");
const baselinePath = join(srcDir, "file-size-baseline.json");

const MAX_NEW_FILE_LINES = 2000;
const MAX_GROWTH_LINES = 50;

export function checkFileSizes(baseline: Record<string, number>, current: Record<string, number>): string[] {
  const failures: string[] = [];
  for (const [file, lines] of Object.entries(current)) {
    const base = baseline[file];
    if (base === undefined) {
      if (lines > MAX_NEW_FILE_LINES) {
        failures.push(
          `${file}: new file has ${lines} lines, exceeding the ${MAX_NEW_FILE_LINES}-line limit; split it before landing.`
        );
      }
      continue;
    }
    if (lines > base + MAX_GROWTH_LINES) {
      failures.push(
        `${file}: has ${lines} lines, ${lines - base} over its baseline of ${base} (max +${MAX_GROWTH_LINES}); split it instead of growing it.`
      );
    }
  }
  return failures;
}

function readCurrentCounts(): Record<string, number> {
  return readLineCounts(srcDir);
}

describe("file-size ratchet", () => {
  test("src/**/*.ts stays within baseline + 50 and new files stay under 2000", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
    const current = readCurrentCounts();
    const failures = checkFileSizes(baseline, current);
    expect(failures).toEqual([]);
  });

  test("baseline covers every current src/**/*.ts file", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
    const current = readCurrentCounts();
    const missing = Object.keys(current).filter((f) => !(f in baseline));
    // New files are allowed by the +50/2000 rule, but the baseline must be
    // updated in the same PR so growth stays visible; report the gap.
    expect(missing).toEqual([]);
  });

  test("boundary: +50 passes, +51 fails", () => {
    expect(checkFileSizes({ "a.ts": 100 }, { "a.ts": 150 })).toEqual([]);
    const failures = checkFileSizes({ "a.ts": 100 }, { "a.ts": 151 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("a.ts");
    expect(checkFileSizes({}, { "new.ts": 2000 })).toEqual([]);
    expect(checkFileSizes({}, { "new.ts": 2001 })).toHaveLength(1);
  });

  test("covers subdirectories with src-relative keys", () => {
    const current = readCurrentCounts();
    // Split-out settings keys and shared utils must stay under the ratchet.
    expect(Object.keys(current).filter((f) => f.includes("/"))).not.toEqual([]);
    expect(current["repo_settings_keys/mode.ts"]).toBeGreaterThan(0);
    expect(current["util/engine.ts"]).toBeGreaterThan(0);
    // Basename-only keys would collide (src/engine.ts vs util/engine.ts).
    expect(current["engine.ts"]).toBeGreaterThan(0);
  });
});
