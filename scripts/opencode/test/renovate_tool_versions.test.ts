import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "../..");
const renovateRaw = readFileSync(join(repoRoot, "renovate.json"), "utf8");
const renovate = JSON.parse(renovateRaw) as {
  extends?: string[];
  customManagers?: {
    description?: string;
    customType?: string;
    managerFilePatterns?: string[];
    matchStrings?: string[];
    datasourceTemplate?: string;
    depNameTemplate?: string;
    autoReplaceStringTemplate?: string;
  }[];
  packageRules?: {
    description?: string;
    matchDatasources?: string[];
    matchPackageNames?: string[];
    matchUpdateTypes?: string[];
    allowedVersions?: string;
    automerge?: boolean;
  }[];
  constraints?: Record<string, string>;
};

const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

function toolManager() {
  return renovate.customManagers?.filter((m) => m.managerFilePatterns?.includes("/^\\.gitea\\/tool-versions\\.env$/"));
}

function temurinManager() {
  return toolManager()?.find((m) => m.depNameTemplate === "eclipse-temurin");
}

function nonDockerManager() {
  return toolManager()?.find((m) => m.depNameTemplate === undefined);
}

// Minimal Handlebars subset used by our autoReplace templates:
// {{{newValue}}}, {{{newDigest}}}, {{#if newDigest}}...{{/if}}.
function compileAutoReplace(template: string, vars: { newValue?: string; newDigest?: string }): string {
  const withConditionals = template.replace(/\{\{#if newDigest\}\}([\s\S]*?)\{\{\/if\}\}/g, vars.newDigest ? "$1" : "");
  return withConditionals
    .replace(/\{\{\{newValue\}\}\}/g, vars.newValue ?? "")
    .replace(/\{\{\{newDigest\}\}\}/g, vars.newDigest ?? "")
    .replace(/\{\{newValue\}\}/g, vars.newValue ?? "")
    .replace(/\{\{newDigest\}\}/g, vars.newDigest ?? "");
}

function extractFirst(matchString: string, content: string) {
  const re = new RegExp(matchString, "g");
  const match = re.exec(content);
  if (!match) return null;
  return { replaceString: match[0], groups: (match.groups ?? {}) as Record<string, string | undefined> };
}

const OLD_DIGEST = `sha256:${"a".repeat(64)}`;
const NEW_DIGEST = `sha256:${"b".repeat(64)}`;
const TAG = "21.0.12_8-jdk";
const OLD_TAG = "21.0.11_9-jdk";

const UNPINNED = "# renovate: datasource=docker depName=eclipse-temurin\nTEMURIN_TAG=21.0.12_8-jdk";
const PINNED_OLD = `# renovate: datasource=docker depName=eclipse-temurin\nTEMURIN_TAG=${TAG}@${OLD_DIGEST}`;
const PINNED_OLD_TAG = `# renovate: datasource=docker depName=eclipse-temurin\nTEMURIN_TAG=${OLD_TAG}@${OLD_DIGEST}`;

describe("renovate tool-versions config", () => {
  test("keeps digest pinning enabled via preset and digest group", () => {
    expect(renovate.extends).toContain("config:best-practices");
    expect(renovate.extends).toContain("group:allDigest");
    expect(renovateRaw).not.toMatch(/"pinDigests"\s*:\s*false/);
    expect(renovateRaw).not.toMatch(/"pinDigest"\s*:\s*false/);
  });

  test("keeps the Temurin 21 restriction intact", () => {
    const rule = renovate.packageRules?.find((r) => r.matchPackageNames?.includes("eclipse-temurin"));
    expect(rule?.allowedVersions).toBe("/^21\\./");
    expect(/^21\./.test(TAG)).toBe(true);
    expect(/^21\./.test(OLD_TAG)).toBe(true);
    expect(/^21\./.test("17.0.0-jdk")).toBe(false);
  });

  test("has separate non-docker and Temurin docker managers for the same file", () => {
    const managers = toolManager();
    expect(managers?.length).toBe(3);
    const nonDocker = nonDockerManager();
    const temurin = temurinManager();
    expect(nonDocker?.matchStrings?.length).toBe(1);
    expect(temurin?.matchStrings?.length).toBe(1);
    expect(temurin?.datasourceTemplate).toBe("docker");
    expect(temurin?.depNameTemplate).toBe("eclipse-temurin");
    expect(temurin?.autoReplaceStringTemplate).toContain("{{{newValue}}}");
    expect(temurin?.autoReplaceStringTemplate).toContain("{{{newDigest}}}");
    // Every matchStrings regex must compile (RE2-compatible subset: no lookahead).
    for (const m of managers ?? []) {
      for (const s of m.matchStrings ?? []) {
        expect(() => new RegExp(s, "g")).not.toThrow();
        expect(s).not.toMatch(/\(\?!|\(\?<=|\(\?<!/);
      }
    }
  });

  test("non-docker extraction still works and never matches the Temurin line", () => {
    const nonDocker = nonDockerManager();
    const temurin = temurinManager();
    const pattern = nonDocker?.matchStrings?.[0] ?? "";
    const temurinPattern = temurin?.matchStrings?.[0] ?? "";
    // Current non-docker pins still extract.
    for (const line of ["BUN_VERSION=1.4.2", "OPENCODE_VERSION=1.18.35", "HELM_VERSION=4.3.0"]) {
      const varName = line.split("=")[0];
      const sample = `# renovate: datasource=github-releases depName=example/${varName}\n${line}`;
      const found = extractFirst(pattern, sample);
      expect(found?.groups.currentValue).toBe(line.split("=")[1]);
    }
    // Managers are mutually exclusive: no duplicate dep for the Temurin line.
    expect(extractFirst(pattern, UNPINNED)).toBeNull();
    expect(extractFirst(pattern, PINNED_OLD)).toBeNull();
    expect(extractFirst(temurinPattern, UNPINNED)?.groups.currentValue).toBe(TAG);
  });

  test("non-docker values never acquire a docker digest suffix", () => {
    const nonDocker = nonDockerManager();
    expect(nonDocker?.autoReplaceStringTemplate).toBeUndefined();
    const sample = "# renovate: datasource=npm depName=@anthropic-ai/claude-code\nCLAUDE_VERSION=2.1.294";
    const found = extractFirst(nonDocker?.matchStrings?.[0] ?? "", sample);
    expect(found?.groups.currentValue).toBe("2.1.294");
    expect(found?.groups.currentDigest).toBeUndefined();
  });
});

describe("temurin tag-and-digest replacement", () => {
  test("initial pin keeps the tag and appends the digest", () => {
    const temurin = temurinManager();
    const pattern = temurin?.matchStrings?.[0] ?? "";
    const template = temurin?.autoReplaceStringTemplate ?? "";
    const found = extractFirst(pattern, UNPINNED);
    expect(found?.groups.currentValue).toBe(TAG);
    expect(found?.groups.currentDigest).toBeUndefined();
    const replaceString = found?.replaceString ?? "";
    expect(UNPINNED).toContain(replaceString);

    const newString = compileAutoReplace(template, { newValue: TAG, newDigest: NEW_DIGEST });
    expect(newString).toBe(`# renovate: datasource=docker depName=eclipse-temurin\nTEMURIN_TAG=${TAG}@${NEW_DIGEST}`);
    const newContent = UNPINNED.replace(replaceString, newString);
    expect(newContent).toContain(`TEMURIN_TAG=${TAG}@${NEW_DIGEST}`);
    expect(newContent).not.toContain(`${NEW_DIGEST}@${NEW_DIGEST}`);

    // Re-extract (mirrors Renovate confirmIfDepUpdated): tag and digest both land.
    const reextracted = extractFirst(pattern, newContent);
    expect(reextracted?.groups.currentValue).toBe(TAG);
    expect(reextracted?.groups.currentDigest).toBe(NEW_DIGEST);
  });

  test("same-tag digest refresh replaces the digest without duplicating it", () => {
    const temurin = temurinManager();
    const pattern = temurin?.matchStrings?.[0] ?? "";
    const template = temurin?.autoReplaceStringTemplate ?? "";
    const found = extractFirst(pattern, PINNED_OLD);
    expect(found?.groups.currentValue).toBe(TAG);
    expect(found?.groups.currentDigest).toBe(OLD_DIGEST);

    const newString = compileAutoReplace(template, { newValue: TAG, newDigest: NEW_DIGEST });
    const newContent = PINNED_OLD.replace(found?.replaceString ?? "", newString);
    expect(newContent).toBe(`# renovate: datasource=docker depName=eclipse-temurin\nTEMURIN_TAG=${TAG}@${NEW_DIGEST}`);
    expect(newContent.match(/@sha256:/g)?.length).toBe(1);

    const reextracted = extractFirst(pattern, newContent);
    expect(reextracted?.groups.currentValue).toBe(TAG);
    expect(reextracted?.groups.currentDigest).toBe(NEW_DIGEST);
  });

  test("tag-plus-digest update moves both without losing the tag", () => {
    const temurin = temurinManager();
    const pattern = temurin?.matchStrings?.[0] ?? "";
    const template = temurin?.autoReplaceStringTemplate ?? "";
    const found = extractFirst(pattern, PINNED_OLD_TAG);
    expect(found?.groups.currentValue).toBe(OLD_TAG);
    expect(found?.groups.currentDigest).toBe(OLD_DIGEST);

    const newString = compileAutoReplace(template, { newValue: TAG, newDigest: NEW_DIGEST });
    const newContent = PINNED_OLD_TAG.replace(found?.replaceString ?? "", newString);
    expect(newContent).toContain(`TEMURIN_TAG=${TAG}@${NEW_DIGEST}`);
    expect(newContent).not.toContain(OLD_TAG);

    const reextracted = extractFirst(pattern, newContent);
    expect(reextracted?.groups.currentValue).toBe(TAG);
    expect(reextracted?.groups.currentDigest).toBe(NEW_DIGEST);
  });
});

describe("worker image consumes the full pinned reference", () => {
  test("Dockerfile keeps a digest-pinned default and passes the full ARG to the jdk stage", () => {
    expect(dockerfile).toMatch(/^ARG TEMURIN_TAG=21\.[^\\s]*@sha256:[0-9a-f]+$/m);
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/eclipse-temurin:\$\{TEMURIN_TAG\} AS jdk/);
  });

  test("workflows and build script pass TEMURIN_TAG through without stripping the digest", () => {
    const workerWorkflow = readFileSync(join(repoRoot, ".github/workflows/jumi-worker-image.yml"), "utf8");
    const checksWorkflow = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    const buildScript = readFileSync(join(repoRoot, ".gitea/scripts/build-worker-image.sh"), "utf8");
    for (const content of [workerWorkflow, checksWorkflow]) {
      expect(content).toContain("grep -v '^#' .gitea/tool-versions.env >> $GITHUB_ENV");
      expect(content).toContain("TEMURIN_TAG=${{ env.TEMURIN_TAG }}");
    }
    expect(buildScript).toContain('--build-arg "TEMURIN_TAG=${TEMURIN_TAG}"');
    for (const content of [workerWorkflow, checksWorkflow, buildScript, dockerfile]) {
      expect(content).not.toMatch(/TEMURIN_TAG%@\*/);
      expect(content).not.toMatch(/cut -d@/);
    }
  });

  test("postgres service pinning and Dockerfile digest defaults remain enabled", () => {
    const checksWorkflow = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checksWorkflow).toContain("image: postgres:18-alpine");
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]+ AS tools/);
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]+ AS runtime/);
    expect(toolVersions).toMatch(/^TEMURIN_TAG=21\./m);
  });
});
