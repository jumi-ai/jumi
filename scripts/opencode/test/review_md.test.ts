import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  headingGlobs,
  loadReviewMdSections,
  readReviewMd,
  selectReviewMdSections,
} from "../src/review_md.ts";
import { makeFile } from "./fixtures.ts";

const REVIEW = `# Review rules

Intro for every review.

## Security

Never log tokens.

## k3s/**, **/Chart.yaml

Bump the checksum annotation when a ConfigMap changes.

### Details

Nested detail stays with its path section.

## \`*.ts\`

Prefer Bun APIs.

\`\`\`md
## docs/**
not a heading inside a fence
\`\`\`

## Dockerfile

Pin base images by digest.
`;

function files(...names: string[]) {
  return names.map((filename) => makeFile({ filename }));
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "jumi-review-md-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("globToRegExp", () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  test("follows gitignore anchoring", () => {
    expect(matches("*.yaml", "a/b/values.yaml")).toBe(true);
    expect(matches("*.yaml", "values.yml")).toBe(false);
    expect(matches("/Chart.yaml", "Chart.yaml")).toBe(true);
    expect(matches("/Chart.yaml", "charts/x/Chart.yaml")).toBe(false);
    expect(matches("k3s/*.yaml", "k3s/a.yaml")).toBe(true);
    expect(matches("k3s/*.yaml", "k3s/apps/a.yaml")).toBe(false);
    expect(matches("k3s/*.yaml", "x/k3s/a.yaml")).toBe(false);
  });

  test("handles ** and directories", () => {
    expect(matches("k3s/**", "k3s/apps/gitea/values.yaml")).toBe(true);
    expect(matches("**/Chart.yaml", "Chart.yaml")).toBe(true);
    expect(matches("**/Chart.yaml", "charts/foo/Chart.yaml")).toBe(true);
    expect(matches("src/**/test.ts", "src/test.ts")).toBe(true);
    expect(matches("src/**/test.ts", "src/a/b/test.ts")).toBe(true);
    expect(matches("deploy/", "deploy/contract.md")).toBe(true);
    expect(matches("deploy/", "deploy")).toBe(false);
    expect(matches("k3s", "apps/k3s/values.yaml")).toBe(true);
  });

  test("handles ? and character classes", () => {
    expect(matches("v?.md", "v1.md")).toBe(true);
    expect(matches("v?.md", "v10.md")).toBe(false);
    expect(matches("[ab].ts", "a.ts")).toBe(true);
    expect(matches("[!ab].ts", "a.ts")).toBe(false);
  });
});

describe("headingGlobs", () => {
  test("treats a pure comma-separated glob list as a path section", () => {
    expect(headingGlobs("k3s/**, **/Chart.yaml")).toEqual(["k3s/**", "**/Chart.yaml"]);
    expect(headingGlobs("`*.ts`")).toEqual(["*.ts"]);
    expect(headingGlobs("values.yaml")).toEqual(["values.yaml"]);
  });

  test("treats any other heading as repo-wide", () => {
    expect(headingGlobs("Security")).toBeUndefined();
    expect(headingGlobs("Dockerfile")).toBeUndefined();
    expect(headingGlobs("Helm charts in k3s/**")).toBeUndefined();
    expect(headingGlobs("k3s/**, Security")).toBeUndefined();
    expect(headingGlobs("!k3s/**")).toBeUndefined();
    expect(headingGlobs("")).toBeUndefined();
  });
});

describe("selectReviewMdSections", () => {
  test("includes a path section when a changed file matches", () => {
    const selection = selectReviewMdSections(REVIEW, files("k3s/apps/gitea/values.yaml"));

    expect(selection.text).toContain("## k3s/**, **/Chart.yaml");
    expect(selection.text).toContain("Bump the checksum annotation");
    expect(selection.text).toContain("Nested detail stays with its path section.");
    expect(selection.text).not.toContain("Prefer Bun APIs.");
    expect(selection.pathSections).toBe(2);
    expect(selection.matchedPathSections).toBe(1);
    expect(selection.truncated).toBe(false);
  });

  test("drops a path section when no changed file matches, keeping repo-wide sections", () => {
    const selection = selectReviewMdSections(REVIEW, files("README.md"));

    expect(selection.text).not.toContain("Bump the checksum annotation");
    expect(selection.text).not.toContain("Nested detail");
    expect(selection.text).not.toContain("Prefer Bun APIs.");
    expect(selection.text).toContain("# Review rules");
    expect(selection.text).toContain("Intro for every review.");
    expect(selection.text).toContain("## Security\n\nNever log tokens.");
    expect(selection.text).toContain("## Dockerfile\n\nPin base images by digest.");
    expect(selection.matchedPathSections).toBe(0);
  });

  test("does not treat headings inside code fences as sections", () => {
    const selection = selectReviewMdSections(REVIEW, files("src/index.ts"));

    expect(selection.text).toContain("Prefer Bun APIs.");
    expect(selection.text).toContain("## docs/**\nnot a heading inside a fence");
    expect(selection.pathSections).toBe(2);
  });

  test("returns empty text when only unmatched path sections exist", () => {
    const selection = selectReviewMdSections("## k3s/**\nHelm only.\n", files("src/index.ts"));
    expect(selection.text).toBe("");
  });

  test("truncates to the byte budget and says so", () => {
    const long = `## Rules\n\n${"é".repeat(200)}\n`;
    const selection = selectReviewMdSections(long, [], 51);

    expect(selection.truncated).toBe(true);
    expect(Buffer.byteLength(selection.text, "utf8")).toBeLessThanOrEqual(51);
    expect(selection.text.startsWith("## Rules")).toBe(true);
    expect(selection.text).not.toContain("�");
    expect(selection.bytes).toBeGreaterThan(51);
  });
});

describe("loadReviewMdSections", () => {
  test("reads REVIEW.md from the checkout root", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "REVIEW.md"), REVIEW);
      const selection = await loadReviewMdSections(dir, files("charts/foo/Chart.yaml"));
      expect(selection?.text).toContain("Bump the checksum annotation");
    });
  });

  test("injects nothing when REVIEW.md is missing", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "docs"));
      await writeFile(join(dir, "docs", "REVIEW.md"), "## Rules\nNot the root file.\n");
      expect(await loadReviewMdSections(dir, files("k3s/a.yaml"))).toBeUndefined();
    });
  });

  test("does not follow a REVIEW.md symlink", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "secret.md"), "## Rules\nsecret\n");
      await symlink(join(dir, "secret.md"), join(dir, "REVIEW.md"));
      expect(await readReviewMd(dir)).toBeUndefined();
    });
  });

  test("truncates a long REVIEW.md instead of failing", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "REVIEW.md"), `## Rules\n\n${"x".repeat(10_000)}\n`);
      const selection = await loadReviewMdSections(dir, [], 1_000);
      expect(selection?.truncated).toBe(true);
      expect(selection?.text.length).toBe(1_000);
    });
  });
});
