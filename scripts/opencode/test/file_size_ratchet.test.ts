import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  const out: Record<string, number> = {};
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(srcDir, entry), "utf8");
    if (text === "") {
      out[entry] = 0;
      continue;
    }
    const parts = text.split("\n");
    // Match the baseline's `splitlines` counting: a single trailing newline
    // does not add an extra line.
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    out[entry] = parts.length;
  }
  return out;
}

describe("file-size ratchet", () => {
  test("src/*.ts stays within baseline + 50 and new files stay under 2000", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;
    const current = readCurrentCounts();
    const failures = checkFileSizes(baseline, current);
    expect(failures).toEqual([]);
  });

  test("baseline covers every current src/*.ts file", () => {
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
});
