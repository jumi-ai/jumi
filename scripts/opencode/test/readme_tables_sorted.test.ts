import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(process.cwd(), "..", "..", "README.md"), "utf8");

/**
 * Configuration tables (header first cell `Name`): rows stay sorted by name
 * so parallel additions land in different hunks instead of conflicting at the
 * same spot. See `docs/repo-settings.md` ("Adding a setting").
 */
function nameTables(text: string): Array<{ start: number; keys: string[] }> {
  const tables: Array<{ start: number; keys: string[] }> = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.startsWith("|")) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] as string).startsWith("|")) j++;
    const header = (lines[i] as string).split("|").map((cell) => cell.trim());
    if (header[1] === "Name") {
      const keys: string[] = [];
      for (const row of lines.slice(i + 2, j)) {
        const match = /\| `([^`]+)`/.exec(row);
        if (match?.[1]) keys.push(match[1]);
      }
      tables.push({ start: i + 1, keys });
    }
    i = j;
  }
  return tables;
}

describe("readme tables", () => {
  test("configuration tables are sorted by name", () => {
    const tables = nameTables(readme);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.keys).toEqual([...table.keys].sort());
    }
  });
});
