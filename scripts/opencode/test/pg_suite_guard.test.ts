import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Built from parts so this guard file does not match its own scan for the marker.
const PG_ENV_MARKER = ["JUMI_TEST_", "DATABASE_URL"].join("");

const TEST_DIR = import.meta.dir;
const PACKAGE_JSON = join(TEST_DIR, "..", "package.json");

function globToRegExp(glob: string): RegExp {
  // Supports the `*`/`**` globs used by the `test:pg` script.
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$+.?()|{}[]".includes(ch ?? "")) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Path patterns from the `test:pg` script that select test files. */
export function testPgPatterns(scripts: Record<string, string | undefined>): string[] {
  const script = scripts["test:pg"] ?? "";
  return script
    .split(/\s+/)
    .filter((token) => token.endsWith(".test.ts") || token.includes("*"))
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

export function isPickedByTestPg(relativePosixPath: string, patterns: string[]): boolean {
  const normalized = relativePosixPath.replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const normPattern = pattern.replace(/^\.\//, "");
    if (!normPattern.includes("*")) return normalized === normPattern;
    return globToRegExp(normPattern).test(normalized);
  });
}

export function findUnpickedPgFiles(relativePosixPaths: string[], patterns: string[]): string[] {
  return relativePosixPaths.filter((path) => !isPickedByTestPg(path, patterns));
}

async function listTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("postgres suite discovery guard", () => {
  test("every test file that needs Postgres is picked up by test:pg", async () => {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as { scripts?: Record<string, string> };
    const patterns = testPgPatterns(pkg.scripts ?? {});
    expect(patterns.length).toBeGreaterThan(0);
    const files = await listTestFiles(TEST_DIR);
    const withMarker: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      // Paths are relative to the package root so they can be matched against
      // the `test:pg` script patterns (e.g. `./test/*_pg.test.ts`).
      if (content.includes(PG_ENV_MARKER)) withMarker.push(join("test", relative(TEST_DIR, file)).split(sep).join("/"));
    }
    expect(withMarker.length).toBeGreaterThan(0);
    const unpicked = findUnpickedPgFiles(withMarker, patterns);
    if (unpicked.length > 0) {
      throw new Error(
        `test:pg misses Postgres test files: ${unpicked.join(", ")} — name them '*_pg.test.ts' so the test:pg glob picks them up`
      );
    }
  });

  test("flags a scratch file that reads the marker without being picked up", () => {
    const patterns = ["./test/*_pg.test.ts"];
    expect(isPickedByTestPg("test/review_jobs_pg.test.ts", patterns)).toBe(true);
    expect(isPickedByTestPg("test/scratch_missed.test.ts", patterns)).toBe(false);
    expect(findUnpickedPgFiles(["test/review_jobs_pg.test.ts", "test/scratch_missed.test.ts"], patterns)).toEqual([
      "test/scratch_missed.test.ts",
    ]);
  });
});
