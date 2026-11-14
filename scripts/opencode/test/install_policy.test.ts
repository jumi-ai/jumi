import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConflictPrompt, buildFollowupPrompt, buildImplementPrompt, resolveOpenCodePrompt } from "../src/git.ts";
import { formatInstalledToolsBlock, loadInstalledToolsManifest, withInstalledTools } from "../src/installed_tools.ts";
import { buildPROpenedPrompt, TOOL_INSTALL_RULE, TOOL_INSTALL_RULE_SENTENCE } from "../src/prompt.ts";
import { makePR, makeRepo } from "./fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function withManifestEnv(path: string | undefined, run: () => void): void {
  const previous = process.env.JUMI_INSTALLED_TOOLS_PATH;
  try {
    if (path === undefined) delete process.env.JUMI_INSTALLED_TOOLS_PATH;
    else process.env.JUMI_INSTALLED_TOOLS_PATH = path;
    run();
  } finally {
    if (previous === undefined) delete process.env.JUMI_INSTALLED_TOOLS_PATH;
    else process.env.JUMI_INSTALLED_TOOLS_PATH = previous;
  }
}

describe("shared install rule", () => {
  test("reviewer prompt contains the shared install rule and no package-installs ban", () => {
    withManifestEnv(undefined, () => {
      // Point at a missing manifest so the tools block does not interfere.
      process.env.JUMI_INSTALLED_TOOLS_PATH = join(tmpdir(), `jumi-no-manifest-${Date.now()}`);
      const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
      expect(prompt).toContain(TOOL_INSTALL_RULE_SENTENCE);
      expect(prompt).toContain(TOOL_INSTALL_RULE);
      expect(prompt).not.toContain("package installs");
      expect(prompt).toContain("mutating git commands");
      expect(prompt).toContain("helm upgrade");
      expect(prompt).toContain("helm install");
      expect(prompt).toContain("kubectl apply");
      expect(prompt).toContain("charts/*.tgz");
      expect(prompt).toContain("forge host stays denied");
    });
  });

  test("implement, follow-up and conflict prompts contain the identical rule text", () => {
    for (const prompt of [buildImplementPrompt(), buildFollowupPrompt(), buildConflictPrompt()]) {
      expect(prompt).toContain(TOOL_INSTALL_RULE_SENTENCE);
      expect(prompt).toContain(TOOL_INSTALL_RULE);
    }
  });

  test("review-proof and worker-proof skills carry the shared sentence verbatim", () => {
    const reviewProof = readFileSync(join(REPO_ROOT, "review-skills/review-proof/SKILL.md"), "utf8");
    const workerProof = readFileSync(join(REPO_ROOT, "review-skills/worker-proof/SKILL.md"), "utf8");
    expect(reviewProof).toContain(TOOL_INSTALL_RULE_SENTENCE);
    expect(workerProof).toContain(TOOL_INSTALL_RULE_SENTENCE);
    expect(reviewProof).not.toContain("not permission to install");
    expect(reviewProof).toContain("Missing proof after trying to install what is needed is a limitation");
  });

  test("Dockerfile writes the manifest from the version-check commands and the worker appends java", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("/app/installed-tools.txt");
    // Manifest generation reuses the same version-check commands.
    for (const cmd of [
      "git --version",
      "rg --version",
      "jq --version",
      "helm version --short",
      "yq --version",
      "uv --version",
      "shellcheck --version",
      "import yaml",
      "python3.13 --version",
    ]) {
      expect(dockerfile).toContain(cmd);
    }
    expect(dockerfile).toContain("printf 'java %s\\n'");
  });
});

describe("installed_tools block", () => {
  test("renders from a manifest file in reviewer and worker prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tools-"));
    try {
      const manifest = join(dir, "installed-tools.txt");
      await writeFile(manifest, "git git version 2.44.0\nrg ripgrep 14.0.0\n");
      const previous = process.env.JUMI_INSTALLED_TOOLS_PATH;
      process.env.JUMI_INSTALLED_TOOLS_PATH = manifest;
      try {
        expect(loadInstalledToolsManifest()).toEqual(["git git version 2.44.0", "rg ripgrep 14.0.0"]);
        const block = formatInstalledToolsBlock(["git git version 2.44.0"]);
        expect(block).toContain("<installed_tools>");
        expect(block).toContain("These are installed;");
        expect(block).toContain("command -v");
        expect(block).toContain("install anything else");

        const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
        expect(prompt).toContain("<installed_tools>");
        expect(prompt).toContain("git git version 2.44.0");
        expect(prompt).toContain("do not probe");

        const workdir = await mkdtemp(join(tmpdir(), "jumi-work-"));
        try {
          const workerPrompt = await resolveOpenCodePrompt({
            model: "m",
            workdir,
            trace: { kind: "implement", owner: "o", repo: "r" },
          });
          expect(workerPrompt).toContain("<installed_tools>");
          expect(workerPrompt).toContain("git git version 2.44.0");
          expect(workerPrompt).toContain(TOOL_INSTALL_RULE_SENTENCE);
        } finally {
          await rm(workdir, { recursive: true, force: true });
        }

        // Already-stamped prompts are not double-wrapped.
        const once = withInstalledTools("base");
        expect(once).toContain("<installed_tools>");
        expect(withInstalledTools(once)).toBe(once);
      } finally {
        if (previous === undefined) delete process.env.JUMI_INSTALLED_TOOLS_PATH;
        else process.env.JUMI_INSTALLED_TOOLS_PATH = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing manifest omits the block", async () => {
    const previous = process.env.JUMI_INSTALLED_TOOLS_PATH;
    process.env.JUMI_INSTALLED_TOOLS_PATH = join(tmpdir(), `jumi-missing-${Date.now()}-manifest.txt`);
    try {
      expect(loadInstalledToolsManifest()).toBeUndefined();
      const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
      expect(prompt).not.toContain("<installed_tools>");
      const workdir = await mkdtemp(join(tmpdir(), "jumi-work-"));
      try {
        const workerPrompt = await resolveOpenCodePrompt({
          model: "m",
          workdir,
          trace: { kind: "implement", owner: "o", repo: "r" },
        });
        expect(workerPrompt).not.toContain("<installed_tools>");
        expect(workerPrompt).toContain(TOOL_INSTALL_RULE_SENTENCE);
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.JUMI_INSTALLED_TOOLS_PATH;
      else process.env.JUMI_INSTALLED_TOOLS_PATH = previous;
    }
  });
});
