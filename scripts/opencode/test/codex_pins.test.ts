import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allowedVersionsToRegExp,
  compileAutoReplace,
  extractFirst,
  parseEnv,
  requireEnvValue,
  validateArchPin,
} from "./tool_pin_helpers.ts";

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

function codexDigestManagers() {
  return renovate.customManagers?.filter(
    (m) => m.depNameTemplate === "openai/codex" && m.datasourceTemplate === "github-release-attachments"
  );
}

function codexRule() {
  return renovate.packageRules?.filter((r) => r.matchPackageNames?.includes("openai/codex"));
}

function readCodexPin(content: string) {
  const env = parseEnv(content);
  const rules = codexRule() ?? [];
  const numericRule = rules.find((r) => r.matchDatasources?.includes("github-releases"));
  const tagRule = rules.find((r) => r.matchDatasources?.includes("github-release-attachments"));
  return {
    version: requireEnvValue(env, "CODEX_VERSION"),
    amdTag: requireEnvValue(env, "CODEX_AMD64_TAG"),
    armTag: requireEnvValue(env, "CODEX_ARM64_TAG"),
    amdSha: requireEnvValue(env, "CODEX_SHA256_AMD64"),
    armSha: requireEnvValue(env, "CODEX_SHA256_ARM64"),
    allowedVersion: numericRule?.allowedVersions ? allowedVersionsToRegExp(numericRule.allowedVersions) : undefined,
    allowedTag: tagRule?.allowedVersions ? allowedVersionsToRegExp(tagRule.allowedVersions) : undefined,
  };
}

// Synthetic fixtures only: the representative-update simulation is about the
// regex managers and autoReplace templates, not about any real release.
const SYN_OLD_VERSION = "0.0.1";
const SYN_NEW_VERSION = "0.0.2";
const SYN_OLD_TAG = "rust-v0.0.1";
const SYN_NEW_TAG = "rust-v0.0.2";
const SYN_OLD_AMD_SHA = "a".repeat(64);
const SYN_OLD_ARM_SHA = "b".repeat(64);
const SYN_NEW_AMD_SHA = "c".repeat(64);
const SYN_NEW_ARM_SHA = "d".repeat(64);

function syntheticOldContent(): string {
  return [
    "# renovate: datasource=github-release-attachments depName=openai/codex",
    `CODEX_AMD64_TAG=${SYN_OLD_TAG}`,
    `CODEX_SHA256_AMD64=${SYN_OLD_AMD_SHA}`,
    "# renovate: datasource=github-release-attachments depName=openai/codex",
    `CODEX_ARM64_TAG=${SYN_OLD_TAG}`,
    `CODEX_SHA256_ARM64=${SYN_OLD_ARM_SHA}`,
  ].join("\n");
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

  test("release tag maps to the numeric version; prereleases stay out", () => {
    const pin = readCodexPin(toolVersions);
    const numericRule = (codexRule() ?? []).find((r) => r.matchDatasources?.includes("github-releases"));
    const tagRule = (codexRule() ?? []).find((r) => r.matchDatasources?.includes("github-release-attachments"));
    const extract = numericRule?.extractVersion ?? "^rust-v(?<version>.+)$";
    const tagVersion = new RegExp(extract).exec(pin.amdTag)?.groups?.version;
    expect(tagVersion).toBe(pin.version);
    const allowed = allowedVersionsToRegExp(numericRule?.allowedVersions ?? "/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(allowed.test(pin.version)).toBe(true);
    expect(allowed.test("0.0.1-alpha.1")).toBe(false);
    expect(allowed.test("0.0.1-beta.1")).toBe(false);
    expect(allowed.test(SYN_NEW_VERSION)).toBe(true);
    const tagAllowed = allowedVersionsToRegExp(tagRule?.allowedVersions ?? "/^rust-v[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(tagAllowed.test(pin.amdTag)).toBe(true);
    expect(tagAllowed.test("rust-v0.0.1-alpha.1")).toBe(false);
    expect(tagAllowed.test(SYN_NEW_TAG)).toBe(true);
    expect(tagAllowed.test(SYN_NEW_VERSION)).toBe(false);
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
  test("tool-versions.env carries a coherent codex pin", () => {
    const pin = readCodexPin(toolVersions);
    expect(() => validateArchPin({ ...pin, tagScheme: "rust-v" })).not.toThrow();
  });

  test("tags stay paired with the numeric version so digest entries cannot drift", () => {
    const pin = readCodexPin(toolVersions);
    expect(pin.amdTag).toBe(`rust-v${pin.version}`);
    expect(pin.armTag).toBe(`rust-v${pin.version}`);
    expect(pin.amdTag).toBe(pin.armTag);
  });

  test("digest managers extract the tag and its arch checksum together", () => {
    const pin = readCodexPin(toolVersions);
    const managers = codexDigestManagers();
    const amdPattern = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_AMD64_TAG"))?.matchStrings?.[0] ?? "";
    const armPattern = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_ARM64_TAG"))?.matchStrings?.[0] ?? "";
    const amd = extractFirst(amdPattern, toolVersions);
    expect(amd?.groups.currentValue).toBe(pin.amdTag);
    expect(amd?.groups.currentDigest).toBe(pin.amdSha);
    const arm = extractFirst(armPattern, toolVersions);
    expect(arm?.groups.currentValue).toBe(pin.armTag);
    expect(arm?.groups.currentDigest).toBe(pin.armSha);
  });

  test("a representative update moves the version and both archive pins coherently", () => {
    const managers = codexDigestManagers();
    const amdManager = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_AMD64_TAG"));
    const armManager = managers?.find((m) => m.matchStrings?.[0]?.includes("CODEX_ARM64_TAG"));
    const amdPattern = amdManager?.matchStrings?.[0] ?? "";
    const armPattern = armManager?.matchStrings?.[0] ?? "";
    const oldContent = syntheticOldContent();
    const amd = extractFirst(amdPattern, oldContent);
    const arm = extractFirst(armPattern, oldContent);
    expect(amd?.groups.currentValue).toBe(SYN_OLD_TAG);
    expect(amd?.groups.currentDigest).toBe(SYN_OLD_AMD_SHA);
    expect(arm?.groups.currentValue).toBe(SYN_OLD_TAG);
    expect(arm?.groups.currentDigest).toBe(SYN_OLD_ARM_SHA);
    // The lookup yields the tag verbatim (tag-form versioning, no
    // extractVersion); each arch autoReplace template writes that tag with
    // its new digest.
    const amdNew = compileAutoReplace(amdManager?.autoReplaceStringTemplate ?? "", {
      newValue: SYN_NEW_TAG,
      newDigest: SYN_NEW_AMD_SHA,
    });
    const armNew = compileAutoReplace(armManager?.autoReplaceStringTemplate ?? "", {
      newValue: SYN_NEW_TAG,
      newDigest: SYN_NEW_ARM_SHA,
    });
    expect(amdNew).toBe(`CODEX_AMD64_TAG=${SYN_NEW_TAG}\nCODEX_SHA256_AMD64=${SYN_NEW_AMD_SHA}`);
    expect(armNew).toBe(`CODEX_ARM64_TAG=${SYN_NEW_TAG}\nCODEX_SHA256_ARM64=${SYN_NEW_ARM_SHA}`);
    const updated = oldContent.replace(amd?.replaceString ?? "", amdNew).replace(arm?.replaceString ?? "", armNew);
    expect(updated).toContain(SYN_NEW_TAG);
    expect(updated).toContain(SYN_NEW_AMD_SHA);
    expect(updated).toContain(SYN_NEW_ARM_SHA);
    expect(updated).not.toContain(SYN_OLD_TAG);
    expect(updated).not.toContain(SYN_OLD_AMD_SHA);
    expect(updated).not.toContain(SYN_OLD_ARM_SHA);
    expect(extractFirst(amdPattern, updated)?.groups.currentDigest).toBe(SYN_NEW_AMD_SHA);
    expect(extractFirst(armPattern, updated)?.groups.currentDigest).toBe(SYN_NEW_ARM_SHA);
  });

  test("a non-stable version fails coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() =>
      validateArchPin({
        ...pin,
        version: "0.0.1-alpha.1",
        amdTag: "rust-v0.0.1-alpha.1",
        armTag: "rust-v0.0.1-alpha.1",
        tagScheme: "rust-v",
      })
    ).toThrow();
  });

  test("a version that does not match the tag fails coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() => validateArchPin({ ...pin, amdTag: SYN_NEW_TAG, tagScheme: "rust-v" })).toThrow();
  });

  test("mismatched arch tags fail coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() =>
      validateArchPin({
        version: pin.version,
        amdTag: pin.amdTag,
        armTag: SYN_NEW_TAG,
        amdSha: pin.amdSha,
        armSha: pin.armSha,
        tagScheme: "rust-v",
      })
    ).toThrow();
  });

  test("a short digest fails coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() => validateArchPin({ ...pin, amdSha: "a".repeat(63), tagScheme: "rust-v" })).toThrow();
  });

  test("a non-hex digest fails coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() => validateArchPin({ ...pin, armSha: "G".repeat(64), tagScheme: "rust-v" })).toThrow();
  });

  test("identical arch digests fail coherence", () => {
    const pin = readCodexPin(toolVersions);
    expect(() => validateArchPin({ ...pin, armSha: pin.amdSha, tagScheme: "rust-v" })).toThrow();
  });
});

describe("codex build consumes one effective pin and fails closed", () => {
  test("Dockerfile takes the pin as build-args with no stale baked default", () => {
    expect(dockerfile).toMatch(/^ARG CODEX_VERSION$/m);
    expect(dockerfile).toMatch(/^ARG CODEX_SHA256_AMD64$/m);
    expect(dockerfile).toMatch(/^ARG CODEX_SHA256_ARM64$/m);
    expect(dockerfile).not.toMatch(/^ARG CODEX_VERSION=/m);
    expect(dockerfile).not.toMatch(/^ARG CODEX_SHA256_AMD64=/m);
    expect(dockerfile).not.toMatch(/^ARG CODEX_SHA256_ARM64=/m);
    // Fail closed on missing wiring.
    expect(dockerfile).toContain(': "${CODEX_VERSION:?CODEX_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${CODEX_SHA256_AMD64:?CODEX_SHA256_AMD64 build-arg is required}"');
    expect(dockerfile).toContain(': "${CODEX_SHA256_ARM64:?CODEX_SHA256_ARM64 build-arg is required}"');
  });

  test("Dockerfile downloads the official musl-package assets and verifies sha256", () => {
    expect(dockerfile).toContain(
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-${codex_target}.tar.gz"
    );
    // The Android cmdline-tools archive is officially named *_latest.zip with a
    // pinned numeric version, and it installs into cmdline-tools/latest by
    // layout convention; neither is a floating tag.
    const urls = [...dockerfile.matchAll(/https:\/\/[^\s"']+/g)].map((m) => m[0]);
    const floating = urls.filter(
      (u) => /\/latest/i.test(u) && !u.includes("dl.google.com/android/repository/commandlinetools")
    );
    expect(floating).toEqual([]);
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
