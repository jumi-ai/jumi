import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// Official stable pins verified against the upstream release checksum files.
const PROMTOOL_VERSION = "3.16.0";
const PROMTOOL_TAG = "v3.16.0";
const PROMTOOL_SHA256_AMD64 = "68727009472a2c02e1ff7f062fd5b3e637285bffc8fc2d340c76fb449d6e0f34";
const PROMTOOL_SHA256_ARM64 = "fd8571b8162f4020232d886f17340bcf92e1722985ae3b4c1d096157826c0fbe";
const TOFU_VERSION = "1.13.9";
const TOFU_TAG = "v1.13.9";
const TOFU_SHA256_AMD64 = "bc44eb6b06446ba83bd4072114891987f590f66cca712737a7f1147c50c539ce";
const TOFU_SHA256_ARM64 = "04f7c93828b859d420269ed30f923ffebf09157b5d7fb95bf8d88a4d208b7fa3";
const KUBECONFORM_VERSION = "0.8.0";
const KUBECONFORM_TAG = "v0.8.0";
const KUBECONFORM_SHA256_AMD64 = "9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883";
const KUBECONFORM_SHA256_ARM64 = "1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87";
const KUBECTL_VERSION = "1.37.2";
const KUBECTL_TAG = "v1.37.2";
const KUBECTL_SHA256_AMD64 = "c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4";
const KUBECTL_SHA256_ARM64 = "fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509";

describe("infra CLI pin coherence", () => {
  test("tool-versions.env carries each pin with per-arch sha256", () => {
    expect(toolVersions).toContain(`PROMTOOL_VERSION=${PROMTOOL_VERSION}`);
    expect(toolVersions).toContain(`PROMTOOL_AMD64_TAG=${PROMTOOL_TAG}`);
    expect(toolVersions).toContain(`PROMTOOL_ARM64_TAG=${PROMTOOL_TAG}`);
    expect(toolVersions).toContain(`PROMTOOL_SHA256_AMD64=${PROMTOOL_SHA256_AMD64}`);
    expect(toolVersions).toContain(`PROMTOOL_SHA256_ARM64=${PROMTOOL_SHA256_ARM64}`);
    expect(toolVersions).toContain(`TOFU_VERSION=${TOFU_VERSION}`);
    expect(toolVersions).toContain(`TOFU_AMD64_TAG=${TOFU_TAG}`);
    expect(toolVersions).toContain(`TOFU_ARM64_TAG=${TOFU_TAG}`);
    expect(toolVersions).toContain(`TOFU_SHA256_AMD64=${TOFU_SHA256_AMD64}`);
    expect(toolVersions).toContain(`TOFU_SHA256_ARM64=${TOFU_SHA256_ARM64}`);
    expect(toolVersions).toContain(`KUBECONFORM_VERSION=${KUBECONFORM_VERSION}`);
    expect(toolVersions).toContain(`KUBECONFORM_AMD64_TAG=${KUBECONFORM_TAG}`);
    expect(toolVersions).toContain(`KUBECONFORM_ARM64_TAG=${KUBECONFORM_TAG}`);
    expect(toolVersions).toContain(`KUBECONFORM_SHA256_AMD64=${KUBECONFORM_SHA256_AMD64}`);
    expect(toolVersions).toContain(`KUBECONFORM_SHA256_ARM64=${KUBECONFORM_SHA256_ARM64}`);
    expect(toolVersions).toContain(`KUBECTL_VERSION=${KUBECTL_VERSION}`);
    expect(toolVersions).toContain(`KUBECTL_AMD64_TAG=${KUBECTL_TAG}`);
    expect(toolVersions).toContain(`KUBECTL_ARM64_TAG=${KUBECTL_TAG}`);
    expect(toolVersions).toContain(`KUBECTL_SHA256_AMD64=${KUBECTL_SHA256_AMD64}`);
    expect(toolVersions).toContain(`KUBECTL_SHA256_ARM64=${KUBECTL_SHA256_ARM64}`);
  });

  test("tags stay paired with the numeric versions", () => {
    for (const [versionName, tagPrefix] of [
      ["PROMTOOL_VERSION", "v"],
      ["TOFU_VERSION", "v"],
      ["KUBECONFORM_VERSION", "v"],
      ["KUBECTL_VERSION", "v"],
    ] as const) {
      const prefix = versionName.replace(/_VERSION$/, "");
      const version = new RegExp(`^${versionName}=(?<v>[^\\s]+)$`, "m").exec(toolVersions)?.groups?.v;
      const amd = new RegExp(`^${prefix}_AMD64_TAG=(?<t>[^\\s]+)$`, "m").exec(toolVersions)?.groups?.t;
      const arm = new RegExp(`^${prefix}_ARM64_TAG=(?<t>[^\\s]+)$`, "m").exec(toolVersions)?.groups?.t;
      expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
      expect(amd).toBe(`${tagPrefix}${version}`);
      expect(arm).toBe(`${tagPrefix}${version}`);
      for (const arch of ["AMD64", "ARM64"] as const) {
        const sha = new RegExp(`^${prefix}_SHA256_${arch}=(?<s>[0-9a-f]{64})$`, "m").exec(toolVersions)?.groups?.s;
        expect(sha?.length).toBe(64);
      }
    }
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
    // No kubeconfig or credentials are baked in: kubectl stays client-only.
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
      expect(text).toContain("grep -v '^#' .gitea/tool-versions.env >> $GITHUB_ENV");
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
    // kubectl is version-only: kubernetes/kubernetes releases carry no kubectl
    // binary attachment, so no attachment manager can resolve the dl.k8s.io
    // hash. KUBECTL_VERSION stays Renovate-tracked via github-releases while
    // the per-arch SHAs follow manually (NOTE(kubectl)), with the image-build
    // sha256sum -c as the fail-closed backstop.
    const kubectlManagers = managers?.filter((m) => m.depNameTemplate === "kubernetes/kubernetes");
    expect(kubectlManagers?.length).toBe(0);
    expect(toolVersions).toContain(
      "# renovate: datasource=github-releases depName=kubernetes/kubernetes\nKUBECTL_VERSION="
    );
    expect(toolVersions).toContain("NOTE(kubectl)");
    expect(toolVersions).not.toContain("datasource=github-release-attachments depName=kubernetes/kubernetes");
  });
});
