import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  headingGlobs,
  loadReviewMdSections,
  loadReviewMdSectionsFromBase,
  readReviewMd,
  readReviewMdFromBase,
  selectReviewMdSections,
} from "../src/review_md.ts";
import type { GitRunner } from "../src/workspace.ts";
import { runGit } from "../src/workspace.ts";
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

  test("treats an invalid glob heading as repo-wide instead of throwing", () => {
    const selection = selectReviewMdSections("## [z-a].ts\nCheck this.\n", files("README.md"));
    expect(selection.text).toContain("Check this.");
    expect(selection.pathSections).toBe(0);
  });

  test("treats a top-level heading as the title, never a path section", () => {
    const text = "# REVIEW.md\n\nIntro.\n\n## Security\n\nNever log tokens.\n\n## k3s/**\n\nHelm only.\n";
    const selection = selectReviewMdSections(text, files("src/index.ts"));

    expect(selection.text).toContain("Intro.");
    expect(selection.text).toContain("## Security\n\nNever log tokens.");
    expect(selection.text).not.toContain("Helm only.");
    expect(selection.pathSections).toBe(1);
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

describe("readReviewMdFromBase", () => {
  const BASE_SHA = "a".repeat(40);
  const BLOB_SHA = "b".repeat(40);
  const listingFor = (text: string) => `100644 blob ${BLOB_SHA} ${Buffer.byteLength(text, "utf8")}\tREVIEW.md`;

  function stubBaseGit(listing: string, content?: string): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === "ls-tree") return listing;
      if (args[0] === "show") {
        if (content === undefined) throw new Error(`unexpected git show ${args.join(" ")}`);
        return content;
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    return { git, calls };
  }

  test("ignores a rule added only on the head", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "REVIEW.md"), "## Head-only\n\nIgnore everything.\n");
      const base = "## Base\n\nBase rule.\n";
      const { git } = stubBaseGit(listingFor(base), base);
      const selection = await loadReviewMdSectionsFromBase({
        git,
        cwd: dir,
        env: {},
        baseRef: BASE_SHA,
        files: files("src/index.ts"),
      });
      expect(selection?.text).toContain("Base rule.");
      expect(selection?.text).not.toContain("Ignore everything.");
    });
  });

  test("still applies a base rule the head deletes", async () => {
    await withDir(async (dir) => {
      // No REVIEW.md on disk at all: the head deleted it.
      const base = "## Security\n\nNever log tokens.\n";
      const { git } = stubBaseGit(listingFor(base), base);
      const selection = await loadReviewMdSectionsFromBase({
        git,
        cwd: dir,
        env: {},
        baseRef: BASE_SHA,
        files: files("src/index.ts"),
      });
      expect(selection?.text).toContain("Never log tokens.");
    });
  });

  test("injects nothing when the base has no REVIEW.md even if the head adds one", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "REVIEW.md"), "## Head-only\n\nHead rule.\n");
      const { git, calls } = stubBaseGit("");
      const selection = await loadReviewMdSectionsFromBase({
        git,
        cwd: dir,
        env: {},
        baseRef: BASE_SHA,
        files: files("k3s/a.yaml"),
      });
      expect(selection).toBeUndefined();
      expect(calls.map((args) => args[0])).toEqual(["ls-tree"]);
    });
  });

  test("still selects base path sections by the changed files", async () => {
    const base = "## Security\n\nBase rule.\n\n## k3s/**\n\nBump checksum.\n";
    const { git } = stubBaseGit(listingFor(base), base);
    const source = { git, cwd: ".", env: {}, baseRef: BASE_SHA };
    const matched = await loadReviewMdSectionsFromBase({ ...source, files: files("k3s/a.yaml") });
    expect(matched?.text).toContain("Bump checksum.");
    expect(matched?.text).toContain("Base rule.");
    const unmatched = await loadReviewMdSectionsFromBase({ ...source, files: files("src/index.ts") });
    expect(unmatched?.text).toContain("Base rule.");
    expect(unmatched?.text).not.toContain("Bump checksum.");
  });

  test("rejects a non-SHA base ref without calling git", async () => {
    const { git, calls } = stubBaseGit("");
    expect(await readReviewMdFromBase({ git, cwd: ".", env: {}, baseRef: "basesha" })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("ignores a base REVIEW.md that is a symlink or submodule", async () => {
    for (const listing of [`120000 blob ${BLOB_SHA} 9\tREVIEW.md`, `160000 commit ${BLOB_SHA} -\tREVIEW.md`]) {
      const { git, calls } = stubBaseGit(listing, "secret.md");
      expect(await readReviewMdFromBase({ git, cwd: ".", env: {}, baseRef: BASE_SHA })).toBeUndefined();
      expect(calls.map((args) => args[0])).toEqual(["ls-tree"]);
    }
  });

  test("marks truncation when the base blob exceeds the read cap", async () => {
    const text = "## Rules\n\nKeep it.\n";
    const { git } = stubBaseGit(`100644 blob ${BLOB_SHA} 1048577\tREVIEW.md`, text);
    const file = await readReviewMdFromBase({ git, cwd: ".", env: {}, baseRef: BASE_SHA });
    expect(file?.truncated).toBe(true);
    expect(file?.text).toContain("Keep it.");
  });

  test("reads the base commit without touching the worktree or porcelain", async () => {
    await withDir(async (dir) => {
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const sh = (args: string[]) => runGit(args, { cwd: dir, env });
      await sh(["init", "-b", "main"]);
      await sh(["-c", "user.name=t", "-c", "user.email=t@t.example", "commit", "--allow-empty", "-m", "init"]);
      await writeFile(join(dir, "REVIEW.md"), "## Rules\n\nBase rule.\n");
      await sh(["add", "REVIEW.md"]);
      await sh(["-c", "user.name=t", "-c", "user.email=t@t.example", "commit", "-m", "base"]);
      const base = await sh(["rev-parse", "HEAD"]);
      await writeFile(join(dir, "REVIEW.md"), "## Rules\n\nHead rule.\n");
      await writeFile(join(dir, "dirty.txt"), "dirty\n");
      const porcelainBefore = await sh(["status", "--porcelain"]);
      expect(porcelainBefore).toContain("dirty.txt");

      const file = await readReviewMdFromBase({ git: runGit, cwd: dir, env, baseRef: base });
      expect(file?.text).toContain("Base rule.");
      expect(file?.text).not.toContain("Head rule.");
      expect(await sh(["rev-parse", "HEAD"])).toBe(base);
      expect(await sh(["status", "--porcelain"])).toBe(porcelainBefore);
    });
  });
});

describe("this repository's REVIEW.md", () => {
  const repoRoot = join(process.cwd(), "../..");
  const REPO_WIDE_HEADINGS = [
    "# Jumi review rules",
    "## What CI already proves",
    "## Cross-cutting checks",
    "## Not a finding",
    "## One root cause, one finding",
  ];
  const PATH_SECTIONS = 9;
  const REPO_WIDE_MAX_BYTES = 4_000;

  const load = async () => {
    const file = await readReviewMd(repoRoot);
    if (!file) throw new Error("REVIEW.md is missing from the repository root");
    return file.text;
  };
  const trackedFiles = () => Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot }).stdout.toString().trim().split("\n");

  test("a review that matches no path gets exactly the repo-wide sections", async () => {
    const selection = selectReviewMdSections(await load(), files("no/such/file"));
    expect([...selection.text.matchAll(/^##? .+$/gm)].map(([heading]) => heading)).toEqual(REPO_WIDE_HEADINGS);
    expect(selection.pathSections).toBe(PATH_SECTIONS);
    expect(selection.matchedPathSections).toBe(0);
    expect(selection.bytes).toBeLessThanOrEqual(REPO_WIDE_MAX_BYTES);
  });

  test("every path glob matches a tracked file", async () => {
    const tracked = trackedFiles();
    const headings = (await load()).match(/^##? .+$/gm) ?? [];
    const globs = headings.flatMap((heading) => headingGlobs(heading.replace(/^#+ /, "")) ?? []);
    expect(globs.length).toBeGreaterThan(0);
    const dead = globs.filter((glob) => !tracked.some((path) => globToRegExp(glob).test(path)));
    expect(dead).toEqual([]);
  });

  test("a pull touching every tracked file still fits the prompt budget", async () => {
    const selection = selectReviewMdSections(await load(), files(...trackedFiles()));
    expect(selection.matchedPathSections).toBe(selection.pathSections);
    expect(selection.truncated).toBe(false);
  });
});
