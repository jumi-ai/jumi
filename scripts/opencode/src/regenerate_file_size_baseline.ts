#!/usr/bin/env bun
/**
 * Regenerate `src/file-size-baseline.json` from the current `src/*.ts` line
 * counts. Run `bun run regenerate:file-sizes` (from `scripts/opencode`)
 * after adding, removing, or growing a source file, and commit the result:
 * the freshness test fails when the committed baseline differs from the
 * regenerated one, and the conflict job rebuilds this file with this script
 * instead of handing it to the model.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const srcDir = import.meta.dir;
const baselinePath = join(srcDir, "file-size-baseline.json");

export function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** Line counts for every `*.ts` file in `dir`, keyed by basename. */
export function readLineCounts(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".ts")) continue;
    out[entry] = countLines(readFileSync(join(dir, entry), "utf8"));
  }
  return out;
}

/** Baseline file text: keys sorted, 2-space indent, one trailing newline. */
export function renderBaseline(counts: Record<string, number>): string {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key] as number;
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function baselineFilePath(): string {
  return baselinePath;
}

if (import.meta.main) {
  writeFileSync(baselinePath, renderBaseline(readLineCounts(srcDir)));
  console.log(`wrote ${baselinePath}`);
}
