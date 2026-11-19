import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedVersionsToRegExp, parseEnv, requireEnvValue, validateArchPin } from "./tool_pin_helpers.ts";

const repoRoot = join(process.cwd(), "../..");
const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const renovateRaw = readFileSync(join(repoRoot, "renovate.json"), "utf8");
const renovate = JSON.parse(renovateRaw) as {
  customManagers?: {
    depNameTemplate?: string;
    matchStrings?: string[];
    autoReplaceStringTemplate?: string;
  }[];
};

const TOOLS = [
  { prefix: "PROMTOOL", depName: "prometheus/prometheus", tagScheme: "v" as const },
  { prefix: "TOFU", depName: "opentofu/opentofu", tagScheme: "v" as const },
  { prefix: "KUBECONFORM", depName: "yannh/kubeconform", tagScheme: "v" as const },
  { prefix: "KUBECTL", depName: "kubernetes/kubernetes", tagScheme: "v" as const },
];

function readToolPin(prefix: string, content: string) {
  const env = parseEnv(content);
  return {
    version: requireEnvValue(env, `${prefix}_VERSION`),
    amdTag: requireEnvValue(env, `${prefix}_AMD64_TAG`),
    armTag: requireEnvValue(env, `${prefix}_ARM64_TAG`),
    amdSha: requireEnvValue(env, `${prefix}_SHA256_AMD64`),
    armSha: requireEnvValue(env, `${prefix}_SHA256_ARM64`),
  };
}

describe("infra CLI pin coherence", () => {
  test("tool-versions.env carries each pin with per-arch sha256", () => {
    for (const { prefix, tagScheme } of TOOLS) {
      const pin = readToolPin(prefix, toolVersions);
      expect(() => validateArchPin({ ...pin, tagScheme })).not.toThrow();
    }
  });

  test("tags stay paired with the numeric versions", () => {
    const env = parseEnv(toolVersions);
    for (const { prefix, tagScheme } of TOOLS) {
      const pin = readToolPin(prefix, toolVersions);
      const expected = tagScheme === "v" ? `v${pin.version}` : pin.version;
      expect(env[`${prefix}_VERSION`]).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
      expect(pin.amdTag).toBe(expected);
      expect(pin.armTag).toBe(expected);
    }
  });

  test("versions match the allowed-versions rule from renovate.json", () => {
    const parsed = JSON.parse(renovateRaw) as {
      packageRules?: { matchPackageNames?: string[]; matchDatasources?: string[]; allowedVersions?: string }[];
    };
    for (const { depName } of TOOLS) {
      const rule = parsed.packageRules?.find(
        (r) => r.matchPackageNames?.includes(depName) && r.matchDatasources?.includes("github-releases")
      );
      expect(rule?.allowedVersions).toBe("/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
      const allowed = allowedVersionsToRegExp(rule?.allowedVersions ?? "/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
      const prefix = TOOLS.find((t) => t.depName === depName)?.prefix ?? "";
      const pin = readToolPin(prefix, toolVersions);
      expect(allowed.test(pin.version)).toBe(true);
      expect(allowed.test("0.0.1-alpha.1")).toBe(false);
    }
  });

  test("a non-stable version fails coherence", () => {
    const pin = readToolPin("TOFU", toolVersions);
    expect(() =>
      validateArchPin({
        ...pin,
        version: "0.0.1-alpha.1",
        amdTag: "v0.0.1-alpha.1",
        armTag: "v0.0.1-alpha.1",
        tagScheme: "v",
      })
    ).toThrow();
  });

  test("a version that does not match the tag fails coherence", () => {
    const pin = readToolPin("TOFU", toolVersions);
    expect(() => validateArchPin({ ...pin, amdTag: "v0.0.2", tagScheme: "v" })).toThrow();
  });

  test("mismatched arch tags fail coherence", () => {
    const pin = readToolPin("PROMTOOL", toolVersions);
    expect(() => validateArchPin({ ...pin, armTag: "v0.0.2", tagScheme: "v" })).toThrow();
  });

  test("a short digest fails coherence", () => {
    const pin = readToolPin("KUBECONFORM", toolVersions);
    expect(() => validateArchPin({ ...pin, amdSha: "a".repeat(63), tagScheme: "v" })).toThrow();
  });

  test("a non-hex digest fails coherence", () => {
    const pin = readToolPin("KUBECTL", toolVersions);
    expect(() => validateArchPin({ ...pin, armSha: "Z".repeat(64), tagScheme: "v" })).toThrow();
  });

  test("identical arch digests fail coherence", () => {
    const pin = readToolPin("TOFU", toolVersions);
    expect(() => validateArchPin({ ...pin, armSha: pin.amdSha, tagScheme: "v" })).toThrow();
  });
});

describe("infra CLI build consumes one effective pin and fails closed", () => {
  test("Dockerfile takes the pins as build-args with no stale baked default", () => {
    for (const name of [
      "PROMTOOL_VERSION",
      "PROMTOOL_SHA256_AMD64",
      "PROMTOOL_SHA256_ARM64",
      "TOFU_VERSION",
      "TOFU_SHA256_AMD64",
      "TOFU_SHA256_ARM64",
      "KUBECONFORM_VERSION",
      "KUBECONFORM_SHA256_AMD64",
      "KUBECONFORM_SHA256_ARM64",
      "KUBECTL_VERSION",
      "KUBECTL_SHA256_AMD64",
      "KUBECTL_SHA256_ARM64",
    ]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${name}$`, "m"));
      expect(dockerfile).not.toMatch(new RegExp(`^ARG ${name}=`, "m"));
    }
    expect(dockerfile).toContain(': "${PROMTOOL_VERSION:?PROMTOOL_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${TOFU_VERSION:?TOFU_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${KUBECONFORM_VERSION:?KUBECONFORM_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${KUBECTL_VERSION:?KUBECTL_VERSION build-arg is required}"');
  });

  test("Dockerfile installs promtool, kubeconform, tofu and kubectl into /usr/local/bin", () => {
    expect(dockerfile).toContain(
      "https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/prometheus-${PROMTOOL_VERSION}.linux-${prom_arch}.tar.gz"
    );
    expect(dockerfile).toContain(
      "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${tofu_arch}.zip"
    );
    expect(dockerfile).toContain(
      "https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}/kubeconform-linux-${kubeconform_arch}.tar.gz"
    );
    expect(dockerfile).toContain("https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl");
    expect(dockerfile).toContain(
      'install -m 755 "${tmp_dir}/prometheus-${PROMTOOL_VERSION}.linux-${prom_arch}/promtool" /usr/local/bin/promtool'
    );
    expect(dockerfile).toContain('install -m 755 "${tmp_dir}/tofu" /usr/local/bin/tofu');
    expect(dockerfile).toContain('install -m 755 "${tmp_dir}/kubeconform" /usr/local/bin/kubeconform');
    expect(dockerfile).toContain('install -m 755 "${tmp_dir}/kubectl" /usr/local/bin/kubectl');
    for (const fragment of [
      'echo "${prom_sha256}  ${tmp_dir}/prometheus.tar.gz" | sha256sum -c -',
      'echo "${tofu_sha256}  ${tmp_dir}/tofu.zip" | sha256sum -c -',
      'echo "${kubeconform_sha256}  ${tmp_dir}/kubeconform.tar.gz" | sha256sum -c -',
      'echo "${kubectl_sha256}  ${tmp_dir}/kubectl" | sha256sum -c -',
    ]) {
      expect(dockerfile).toContain(fragment);
    }
    expect(dockerfile).not.toMatch(/KUBECONFIG/);
    expect(dockerfile).not.toMatch(/\.kube/);
  });

  test("Dockerfile smoke-checks the four CLIs and image CI does too", () => {
    expect(dockerfile).toContain("promtool --version");
    expect(dockerfile).toContain("kubeconform -v");
    expect(dockerfile).toContain("tofu version");
    expect(dockerfile).toContain("kubectl version --client");
    const paths = [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
    ];
    for (const path of paths) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("promtool --version");
      expect(text).toContain("kubeconform -v");
      expect(text).toContain("tofu version");
      expect(text).toContain("kubectl version --client");
    }
  });

  test("workflows and build scripts pass the same pins without stripping them", () => {
    const paths = [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
    ];
    for (const path of paths) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      for (const name of [
        "PROMTOOL_VERSION",
        "PROMTOOL_SHA256_AMD64",
        "PROMTOOL_SHA256_ARM64",
        "TOFU_VERSION",
        "TOFU_SHA256_AMD64",
        "TOFU_SHA256_ARM64",
        "KUBECONFORM_VERSION",
        "KUBECONFORM_SHA256_AMD64",
        "KUBECONFORM_SHA256_ARM64",
        "KUBECTL_VERSION",
        "KUBECTL_SHA256_AMD64",
        "KUBECTL_SHA256_ARM64",
      ]) {
        expect(text).toContain(name);
      }
    }
    for (const path of [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ]) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("PROMTOOL_VERSION=${{ env.PROMTOOL_VERSION }}");
      expect(text).toContain("TOFU_VERSION=${{ env.TOFU_VERSION }}");
      expect(text).toContain("KUBECONFORM_VERSION=${{ env.KUBECONFORM_VERSION }}");
      expect(text).toContain("KUBECTL_VERSION=${{ env.KUBECTL_VERSION }}");
      expect(text).toContain("grep -v '^#' .gitea/tool-versions.env >> \"$GITHUB_ENV\"");
    }
  });
});

describe("renovate tracks each infra CLI pin", () => {
  test("renovate.json has a checksum manager for each pin", () => {
    const managers = renovate.customManagers?.filter((m) => m.depNameTemplate !== undefined);
    for (const [depName, prefix] of [
      ["prometheus/prometheus", "PROMTOOL"],
      ["opentofu/opentofu", "TOFU"],
      ["yannh/kubeconform", "KUBECONFORM"],
    ] as const) {
      const pair = managers?.filter((m) => m.depNameTemplate === depName);
      expect(pair?.length).toBe(2);
      expect(pair?.some((m) => m.matchStrings?.[0]?.includes(`${prefix}_AMD64_TAG`))).toBe(true);
      expect(pair?.some((m) => m.matchStrings?.[0]?.includes(`${prefix}_ARM64_TAG`))).toBe(true);
      for (const m of pair ?? []) {
        expect(m?.matchStrings?.length).toBe(1);
        expect(m?.autoReplaceStringTemplate).toContain("{{{newValue}}}");
        expect(m?.autoReplaceStringTemplate).toContain("{{{newDigest}}}");
        expect(() => new RegExp(m?.matchStrings?.[0] ?? "", "g")).not.toThrow();
      }
    }
    const kubectlManagers = managers?.filter((m) => m.depNameTemplate === "kubernetes/kubernetes");
    expect(kubectlManagers?.length).toBe(0);
    expect(toolVersions).toContain(
      "# renovate: datasource=github-releases depName=kubernetes/kubernetes\nKUBECTL_VERSION="
    );
    expect(toolVersions).toContain("NOTE(kubectl)");
    expect(toolVersions).not.toContain("datasource=github-release-attachments depName=kubernetes/kubernetes");
  });
});
