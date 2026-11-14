import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "../..");
const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

// Official stable pins verified against the GitHub API `digest` fields.
const YQ_VERSION = "4.54.3";
const YQ_TAG = "v4.54.3";
const YQ_SHA256_AMD64 = "129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973";
const YQ_SHA256_ARM64 = "89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67";
const UV_VERSION = "0.13.7";
const UV_TAG = "0.13.7";
const UV_SHA256_AMD64 = "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83";
const UV_SHA256_ARM64 = "71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc";

describe("yq/uv pin coherence", () => {
  test("tool-versions.env carries both pins with per-arch checksums", () => {
    expect(toolVersions).toContain(`YQ_VERSION=${YQ_VERSION}`);
    expect(toolVersions).toContain(`YQ_AMD64_TAG=${YQ_TAG}`);
    expect(toolVersions).toContain(`YQ_ARM64_TAG=${YQ_TAG}`);
    expect(toolVersions).toContain(`YQ_SHA256_AMD64=${YQ_SHA256_AMD64}`);
    expect(toolVersions).toContain(`YQ_SHA256_ARM64=${YQ_SHA256_ARM64}`);
    expect(toolVersions).toContain(`UV_VERSION=${UV_VERSION}`);
    expect(toolVersions).toContain(`UV_AMD64_TAG=${UV_TAG}`);
    expect(toolVersions).toContain(`UV_ARM64_TAG=${UV_TAG}`);
    expect(toolVersions).toContain(`UV_SHA256_AMD64=${UV_SHA256_AMD64}`);
    expect(toolVersions).toContain(`UV_SHA256_ARM64=${UV_SHA256_ARM64}`);
  });

  test("tags stay paired with the numeric versions", () => {
    const yqVersion = /^YQ_VERSION=(?<v>[^\s]+)$/m.exec(toolVersions)?.groups?.v;
    const yqAmd = /^YQ_AMD64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    const yqArm = /^YQ_ARM64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    expect(yqVersion).toBe(YQ_VERSION);
    expect(yqAmd).toBe(`v${yqVersion}`);
    expect(yqArm).toBe(`v${yqVersion}`);
    const uvVersion = /^UV_VERSION=(?<v>[^\s]+)$/m.exec(toolVersions)?.groups?.v;
    const uvAmd = /^UV_AMD64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    const uvArm = /^UV_ARM64_TAG=(?<t>[^\s]+)$/m.exec(toolVersions)?.groups?.t;
    expect(uvVersion).toBe(UV_VERSION);
    expect(uvAmd).toBe(uvVersion);
    expect(uvArm).toBe(uvVersion);
  });
});

describe("yq/uv build consumes one effective pin and fails closed", () => {
  test("Dockerfile takes the pins as build-args with no stale baked default", () => {
    for (const name of [
      "YQ_VERSION",
      "YQ_SHA256_AMD64",
      "YQ_SHA256_ARM64",
      "UV_VERSION",
      "UV_SHA256_AMD64",
      "UV_SHA256_ARM64",
    ]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${name}$`, "m"));
      expect(dockerfile).not.toMatch(new RegExp(`^ARG ${name}=`, "m"));
    }
    expect(dockerfile).toContain(': "${YQ_VERSION:?YQ_VERSION build-arg is required}"');
    expect(dockerfile).toContain(': "${UV_VERSION:?UV_VERSION build-arg is required}"');
  });

  test("Dockerfile installs the runtime CLI set and a pre-seeded CPython 3.13", () => {
    expect(dockerfile).toMatch(/curl.*procps.*python-is-python3.*python3-yaml.*shellcheck.*unzip/s);
    expect(dockerfile).toContain("https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/${yq_bin}");
    expect(dockerfile).toContain(
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_target}.tar.gz"
    );
    expect(dockerfile).toContain('echo "${yq_sha256}  ${tmp_dir}/yq" | sha256sum -c -');
    expect(dockerfile).toContain('echo "${uv_sha256}  ${tmp_dir}/uv.tar.gz" | sha256sum -c -');
    expect(dockerfile).toContain("uv python install 3.13 --install-dir /opt/cpython --no-bin");
    expect(dockerfile).toContain('ln -sfn "${py_bin}" /usr/local/bin/python3.13');
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python3");
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python");
    expect(dockerfile).toContain("--requirement /tmp/requirements.txt");
    expect(dockerfile).not.toMatch(/--default/);
    expect(dockerfile).toContain("UV_OFFLINE=1 uv run --no-project --python 3.13 python -V");
    expect(dockerfile).toContain("python3 -c 'import sys; assert sys.version_info[:2] == (3, 13)'");
    expect(dockerfile).toContain("python -c 'import sys; assert sys.version_info[:2] == (3, 13)'");
    expect(dockerfile).toContain("python3 -m pytest --version");
    expect(dockerfile).toContain("python3 -c 'import yaml, pytest'");
    expect(dockerfile).toContain('filter="data"');
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
        "YQ_VERSION",
        "YQ_SHA256_AMD64",
        "YQ_SHA256_ARM64",
        "UV_VERSION",
        "UV_SHA256_AMD64",
        "UV_SHA256_ARM64",
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
      expect(text).toContain("YQ_VERSION=${{ env.YQ_VERSION }}");
      expect(text).toContain("UV_VERSION=${{ env.UV_VERSION }}");
      expect(text).toContain("grep -v '^#' .gitea/tool-versions.env >> $GITHUB_ENV");
    }
  });
});
