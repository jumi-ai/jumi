import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "../..");
const renovateRaw = readFileSync(join(repoRoot, "renovate.json"), "utf8");
const renovate = JSON.parse(renovateRaw) as {
  customManagers?: {
    description?: string;
    customType?: string;
    managerFilePatterns?: string[];
    matchStrings?: string[];
    datasourceTemplate?: string;
    depNameTemplate?: string;
    extractVersionTemplate?: string;
    versioningTemplate?: string;
    autoReplaceStringTemplate?: string;
  }[];
  packageRules?: {
    description?: string;
    matchDatasources?: string[];
    matchPackageNames?: string[];
    extractVersion?: string;
    allowedVersions?: string;
    groupName?: string;
    groupSlug?: string;
  }[];
  minimumReleaseAge?: string;
  prCreation?: string;
  ignoreTests?: boolean;
  automerge?: boolean;
  platformAutomerge?: boolean;
  lockFileMaintenance?: { automerge?: boolean };
  postUpgradeTasks?: unknown;
};
const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

// Official stable pin exercised successfully (see JUMI_TASK evidence). Digests
// are the GitHub API `digest` fields for the musl-package assets of
// rust-v0.166.0, verified byte-for-byte against the 0.165.0 pins they replace.
const CODEX_VERSION = "0.166.0";
const CODEX_TAG = "rust-v0.166.0";
const CODEX_SHA256_AMD64 = "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254";
const CODEX_SHA256_ARM64 = "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6";
const OLD_VERSION = "0.165.0";
const OLD_SHA256_AMD64 = "e97c4463d7f146692a955d7b0e1c8cf48f97cd4d616cd45c5dcab2e8d9743316";
const OLD_SHA256_ARM64 = "c8b2844fdef57498572db960344aee8c836ce9f75c203379da0a9c3a334fc3b7";

function codexDigestManagers() {
  return renovate.customManagers?.filter(
    (m) => m.depNameTemplate === "openai/codex" && m.datasourceTemplate === "github-release-attachments"
  );
}

function codexRule() {
  return renovate.packageRules?.filter((r) => r.matchPackageNames?.includes("openai/codex"));
}

function extractFirst(matchString: string, content: string) {
  const re = new RegExp(matchString, "g");
  const match = re.exec(content);
  if (!match) return null;
  return { replaceString: match[0], groups: (match.groups ?? {}) as Record<string, string | undefined> };
}

// Minimal Handlebars subset used by our autoReplace templates:
// {{{newValue}}} and {{{newDigest}}}.
function compileAutoReplace(template: string, vars: { newValue?: string; newDigest?: string }): string {
  return template
    .replace(/\{\{\{newValue\}\}\}/g, vars.newValue ?? "")
    .replace(/\{\{\{newDigest\}\}\}/g, vars.newDigest ?? "")
    .replace(/\{\{newValue\}\}/g, vars.newValue ?? "")
    .replace(/\{\{newDigest\}\}/g, vars.newDigest ?? "");
}

describe("codex renovate monitoring", () => {
  test("uses hosted-supported digest updating, not self-hosted post-upgrade commands", () => {
    expect(renovate.postUpgradeTasks).toBeUndefined();
    expect(renovateRaw).not.toContain("postUpgradeTasks");
    expect(renovateRaw).not.toContain("allowedPostUpgradeCommands");
  });

  test("discovers openai/codex with rust-v prefix handling and stable-only grouping", () => {
    const managers = codexDigestManagers();
    expect(managers?.length).toBe(2);
    for (const manager of managers ?? []) {
      expect(manager?.managerFilePatterns).toContain("/^\\.gitea\\/tool-versions\\.env$/");
      expect(manager?.matchStrings?.length).toBe(1);
      expect(manager?.datasourceTemplate).toBe("github-release-attachments");
      expect(manager?.depNameTemplate).toBe("openai/codex");
      // Tag-form values: no extractVersionTemplate, so newValue stays
      // rust-vX.Y.Z and getDigest requests releases/tags/rust-vX.Y.Z.
      expect(manager?.extractVersionTemplate).toBeUndefined();
      expect(manager?.versioningTemplate).toBe("regex:^rust-v(?<major>\\d+)\\.(?<minor>\\d+)\\.(?<patch>\\d+)$");
      // The tag is written verbatim; re-adding a prefix would double it to
      // rust-vrust-v….
      expect(manager?.autoReplaceStringTemplate).toContain("{{{newValue}}}");
      expect(manager?.autoReplaceStringTemplate).toContain("{{{newDigest}}}");
      expect(manager?.autoReplaceStringTemplate).not.toContain("rust-v{{{newValue}}}");
    }
    const patterns = (managers ?? []).flatMap((m) => m.matchStrings ?? []);
    expect(patterns.some((s) => s.includes("CODEX_AMD64_TAG"))).toBe(true);
    expect(patterns.some((s) => s.includes("CODEX_ARM64_TAG"))).toBe(true);
    expect(patterns.some((s) => s.includes("CODEX_SHA256_AMD64"))).toBe(true);
    expect(patterns.some((s) => s.includes("CODEX_SHA256_ARM64"))).toBe(true);
    for (const s of patterns) {
      expect(() => new RegExp(s, "g")).not.toThrow();
      expect(s).not.toMatch(/\(\?!|\(\?<=|\(\?<!/);
    }
    const rules = codexRule();
    expect(rules?.length).toBe(2);
    const numericRule = rules?.find((r) => r.matchDatasources?.includes("github-releases"));
    const tagRule = rules?.find((r) => r.matchDatasources?.includes("github-release-attachments"));
    expect(numericRule?.extractVersion).toBe("^rust-v(?<version>.+)$");
    expect(numericRule?.allowedVersions).toBe("/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(numericRule?.groupName).toBe("codex");
    expect(numericRule?.groupSlug).toBe("codex");
    expect(tagRule?.extractVersion).toBeUndefined();
    expect(tagRule?.allowedVersions).toBe("/^rust-v[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(tagRule?.groupName).toBe("codex");
    expect(tagRule?.groupSlug).toBe("codex");
    for (const r of rules ?? []) {
      expect(r?.matchPackageNames).toContain("openai/codex");
    }
  });

  test("release tag maps to the intended numeric version; prereleases stay out", () => {
    const extract = "^rust-v(?<version>.+)$";
    const tagVersion = new RegExp(extract).exec(CODEX_TAG)?.groups?.version;
    expect(tagVersion).toBe(CODEX_VERSION);
    const allowed = /^[0-9]+\.[0-9]+\.[0-9]+$/;
    expect(allowed.test(CODEX_VERSION)).toBe(true);
    expect(allowed.test("0.163.0-alpha.8")).toBe(false);
    expect(allowed.test("0.163.0-beta.1")).toBe(false);
    expect(allowed.test("0.162.1")).toBe(true);
    // Tag-form digest entries keep the rust-v prefix and order via the
    // regex versioning; only stable rust-vX.Y.Z tags pass the filter.
    const tagVersioning = /^rust-v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;
    expect(tagVersioning.exec(CODEX_TAG)?.groups?.major).toBe("0");
    expect(tagVersioning.exec("rust-v0.163.0-alpha.8")).toBeNull();
    const tagAllowed = /^rust-v[0-9]+\.[0-9]+\.[0-9]+$/;
    expect(tagAllowed.test(CODEX_TAG)).toBe(true);
    expect(tagAllowed.test("rust-v0.163.0-alpha.8")).toBe(false);
    expect(tagAllowed.test("rust-v0.163.0")).toBe(true);
    expect(tagAllowed.test("0.163.0")).toBe(false);
  });

  test("preserves release-age, scheduling, review, and CI policy", () => {
    expect(renovate.minimumReleaseAge).toBe("3 days");
    expect(renovate.prCreation).toBe("immediate");
    // Full-automerge pilot: Renovate itself waits for checks, and every
    // update type automerges via platform automerge once the branch ruleset
    // (jumi/opencode-review, checks, image builds) is green.
    expect(renovate.ignoreTests).toBe(false);
    expect(renovate.automerge).toBe(true);
    expect(renovate.platformAutomerge).toBe(true);
    expect(renovate.lockFileMaintenance).toEqual({ automerge: true });
    // No codex-specific automerge widening: the global policy covers codex,
    // so the codex rules carry no per-package automerge bypass.
    const rules = codexRule();
    for (const rule of rules ?? []) {
      expect((rule as Record<string, unknown> | undefined)?.automerge).toBeUndefined();
    }
  });
});

describe("codex pin coherence", () => {
  test("tool-versions.env carries the upgraded pin, not 0.162.1, with both official archive checksums", () => {
    expect(toolVersions).toContain(`CODEX_VERSION=${CODEX_VERSION}`);
    expect(toolVersions).not.toContain(`CODEX_VERSION=${OLD_VERSION}`);
    expect(toolVersions).toContain(`CODEX_AMD64_TAG=${CODEX_TAG}`);
    expect(toolVersions).toContain(`CODEX_ARM64_TAG=${CODEX_TAG}`);
    expect(toolVersions).toContain(`CODEX_SHA256_AMD64=${CODEX_SHA256_AMD64}`);
    expect(toolVersions).toContain(`CODEX_SHA256_ARM64=${CODEX_SHA256_ARM64}`);
    expect(toolVersions).not.toContain(OLD_SHA256_AMD64);
    expect(toolVersions).not.toContain(OLD_SHA256_ARM64);
  });

  test("tags stay paired with the numeric version so digest entries cannot drift", () => {
    const version = /^CODEX_VERSION=(?<v>[^\s]+)$/m.exec(toolVersions)?.groups?.v;
    const amdTag = /^CODEX_AMD64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    const armTag = /^CODEX_ARM64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    expect(version).toBe(CODEX_VERSION);
    expect(amdTag).toBe(`rust-v${version}`);
    expect(armTag).toBe(`rust-v${version}`);
    expect(amdTag).toBe(armTag);
  });

  test("digest managers extract the tag and its arch checksum together", () => {
    const managers = codexDigestManagers();
    const amdPattern = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_AMD64_TAG"))?.matchStrings?.[0] ?? "";
    const armPattern = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_ARM64_TAG"))?.matchStrings?.[0] ?? "";
    const amd = extractFirst(amdPattern, toolVersions);
    expect(amd?.groups.currentValue).toBe(CODEX_TAG);
    expect(amd?.groups.currentDigest).toBe(CODEX_SHA256_AMD64);
    const arm = extractFirst(armPattern, toolVersions);
    expect(arm?.groups.currentValue).toBe(CODEX_TAG);
    expect(arm?.groups.currentDigest).toBe(CODEX_SHA256_ARM64);
  });

  test("a representative update moves the version and both archive pins coherently", () => {
    const managers = codexDigestManagers();
    const amdManager = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_AMD64_TAG"));
    const armManager = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_ARM64_TAG"));
    const amdPattern = amdManager?.matchStrings?.[0] ?? "";
    const armPattern = armManager?.matchStrings?.[0] ?? "";
    const oldContent = [
      "# renovate: datasource=github-release-attachments depName=openai/codex",
      "CODEX_AMD64_TAG=rust-v0.165.0",
      `CODEX_SHA256_AMD64=${OLD_SHA256_AMD64}`,
      "# renovate: datasource=github-release-attachments depName=openai/codex",
      "CODEX_ARM64_TAG=rust-v0.165.0",
      `CODEX_SHA256_ARM64=${OLD_SHA256_ARM64}`,
    ].join("\n");
    const amd = extractFirst(amdPattern, oldContent);
    const arm = extractFirst(armPattern, oldContent);
    expect(amd?.groups.currentValue).toBe("rust-v0.165.0");
    expect(amd?.groups.currentDigest).toBe(OLD_SHA256_AMD64);
    expect(arm?.groups.currentValue).toBe("rust-v0.165.0");
    expect(arm?.groups.currentDigest).toBe(OLD_SHA256_ARM64);
    // The lookup yields the tag verbatim (tag-form versioning, no
    // extractVersion); each arch autoReplace template writes that tag with
    // its new digest. A numeric newValue would hand getDigest a bare
    // version (tags/0.x.y → 404), so assert the tag survives verbatim.
    const amdNew = compileAutoReplace(amdManager?.autoReplaceStringTemplate ?? "", {
      newValue: CODEX_TAG,
      newDigest: CODEX_SHA256_AMD64,
    });
    const armNew = compileAutoReplace(armManager?.autoReplaceStringTemplate ?? "", {
      newValue: CODEX_TAG,
      newDigest: CODEX_SHA256_ARM64,
    });
    expect(amdNew).toBe(`CODEX_AMD64_TAG=${CODEX_TAG}\nCODEX_SHA256_AMD64=${CODEX_SHA256_AMD64}`);
    expect(armNew).toBe(`CODEX_ARM64_TAG=${CODEX_TAG}\nCODEX_SHA256_ARM64=${CODEX_SHA256_ARM64}`);
    const updated = oldContent.replace(amd?.replaceString ?? "", amdNew).replace(arm?.replaceString ?? "", armNew);
    expect(updated).toContain(CODEX_TAG);
    expect(updated).toContain(CODEX_SHA256_AMD64);
    expect(updated).toContain(CODEX_SHA256_ARM64);
    expect(updated).not.toContain("0.165.0");
    expect(updated).not.toContain(OLD_SHA256_AMD64);
    expect(updated).not.toContain(OLD_SHA256_ARM64);
    // Re-extract after the update: both entries land on the new tag+digest.
    expect(extractFirst(amdPattern, updated)?.groups.currentDigest).toBe(CODEX_SHA256_AMD64);
    expect(extractFirst(armPattern, updated)?.groups.currentDigest).toBe(CODEX_SHA256_ARM64);
  });

  test("a version-only bump with stale hashes is detected", () => {
    // New version paired with old archives must not look coherent: the
    // checked-in pins for the new version are the official digests above.
    const staleAmd = toolVersions.includes(CODEX_VERSION) && toolVersions.includes(OLD_SHA256_AMD64);
    const staleArm = toolVersions.includes(CODEX_VERSION) && toolVersions.includes(OLD_SHA256_ARM64);
    expect(staleAmd).toBe(false);
    expect(staleArm).toBe(false);
    expect(toolVersions).toContain(CODEX_SHA256_AMD64);
    expect(toolVersions).toContain(CODEX_SHA256_ARM64);
  });
});

describe("codex build consumes one effective pin and fails closed", () => {
  test("Dockerfile takes the pin as build-args with no stale baked default", () => {
    expect(dockerfile).toMatch(/^ARG CODEX_VERSION$/m);
    expect(dockerfile).toMatch(/^ARG CODEX_SHA256_AMD64$/m);
    expect(dockerfile).toMatch(/^ARG CODEX_SHA256_ARM64$/m);
    expect(dockerfile).not.toMatch(/^ARG CODEX_VERSION=0\.165\.0$/m);
    expect(dockerfile).not.toMatch(OLD_SHA256_AMD64);
    expect(dockerfile).not.toMatch(OLD_SHA256_ARM64);
    // Fail closed on missing wiring.
    expect(dockerfile).toContain(': "${CODEX_VERSION:?CODEX_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${CODEX_SHA256_AMD64:?CODEX_SHA256_AMD64 build-arg is required}"');
    expect(dockerfile).toContain(': "${CODEX_SHA256_ARM64:?CODEX_SHA256_ARM64 build-arg is required}"');
  });

  test("Dockerfile downloads the official musl-package assets and verifies sha256", () => {
    expect(dockerfile).toContain(
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-${codex_target}.tar.gz"
    );
    expect(dockerfile).not.toContain("latest");
    expect(dockerfile).toContain('echo "${codex_sha256}  ${tmp_dir}/codex.tar.gz" | sha256sum -c -');
    expect(dockerfile).toContain('x86_64-unknown-linux-musl"; codex_sha256="${CODEX_SHA256_AMD64}"');
    expect(dockerfile).toContain('aarch64-unknown-linux-musl"; codex_sha256="${CODEX_SHA256_ARM64}"');
    expect(dockerfile).toContain("test -x /usr/local/lib/codex/bin/codex");
  });

  test("workflows and build scripts pass the same Codex pin without stripping it", () => {
    const paths = [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
    ];
    for (const path of paths) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("CODEX_VERSION");
      expect(text).toContain("CODEX_SHA256_AMD64");
      expect(text).toContain("CODEX_SHA256_ARM64");
    }
    for (const path of [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ]) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("CODEX_VERSION=${{ env.CODEX_VERSION }}");
      expect(text).toContain("CODEX_SHA256_AMD64=${{ env.CODEX_SHA256_AMD64 }}");
      expect(text).toContain("CODEX_SHA256_ARM64=${{ env.CODEX_SHA256_ARM64 }}");
      expect(text).toContain("grep -v '^#' .gitea/tool-versions.env >> $GITHUB_ENV");
    }
    for (const path of [".gitea/scripts/build-reviewer-image.sh", ".gitea/scripts/build-worker-image.sh"]) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain('"CODEX_VERSION=${CODEX_VERSION}"');
      expect(text).toContain('"CODEX_SHA256_AMD64=${CODEX_SHA256_AMD64}"');
      expect(text).toContain('"CODEX_SHA256_ARM64=${CODEX_SHA256_ARM64}"');
    }
  });
});
