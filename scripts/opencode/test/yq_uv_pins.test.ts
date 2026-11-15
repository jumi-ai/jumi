import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedVersionsToRegExp, parseEnv, requireEnvValue, validateArchPin } from "./tool_pin_helpers.ts";

const repoRoot = join(process.cwd(), "../..");
const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const renovateRaw = readFileSync(join(repoRoot, "renovate.json"), "utf8");

function readYqPin(content: string) {
  const env = parseEnv(content);
  return {
    version: requireEnvValue(env, "YQ_VERSION"),
    amdTag: requireEnvValue(env, "YQ_AMD64_TAG"),
    armTag: requireEnvValue(env, "YQ_ARM64_TAG"),
    amdSha: requireEnvValue(env, "YQ_SHA256_AMD64"),
    armSha: requireEnvValue(env, "YQ_SHA256_ARM64"),
  };
}

function readUvPin(content: string) {
  const env = parseEnv(content);
  return {
    version: requireEnvValue(env, "UV_VERSION"),
    amdTag: requireEnvValue(env, "UV_AMD64_TAG"),
    armTag: requireEnvValue(env, "UV_ARM64_TAG"),
    amdSha: requireEnvValue(env, "UV_SHA256_AMD64"),
    armSha: requireEnvValue(env, "UV_SHA256_ARM64"),
  };
}

describe("yq/uv pin coherence", () => {
  test("tool-versions.env carries both pins with per-arch checksums", () => {
    expect(() => validateArchPin({ ...readYqPin(toolVersions), tagScheme: "v" })).not.toThrow();
    expect(() => validateArchPin({ ...readUvPin(toolVersions), tagScheme: "bare" })).not.toThrow();
  });

  test("tags stay paired with the numeric versions", () => {
    const yq = readYqPin(toolVersions);
    expect(yq.amdTag).toBe(`v${yq.version}`);
    expect(yq.armTag).toBe(`v${yq.version}`);
    const uv = readUvPin(toolVersions);
    expect(uv.amdTag).toBe(uv.version);
    expect(uv.armTag).toBe(uv.version);
  });

  test("versions match the allowed-versions rules from renovate.json", () => {
    const parsed = JSON.parse(renovateRaw) as {
      packageRules?: { matchPackageNames?: string[]; matchDatasources?: string[]; allowedVersions?: string }[];
    };
    const yqRule = parsed.packageRules?.find(
      (r) => r.matchPackageNames?.includes("mikefarah/yq") && r.matchDatasources?.includes("github-releases")
    );
    const uvRule = parsed.packageRules?.find(
      (r) => r.matchPackageNames?.includes("astral-sh/uv") && r.matchDatasources?.includes("github-releases")
    );
    expect(yqRule?.allowedVersions).toBe("/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(uvRule?.allowedVersions).toBe("/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    const yqAllowed = allowedVersionsToRegExp(yqRule?.allowedVersions ?? "/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    const uvAllowed = allowedVersionsToRegExp(uvRule?.allowedVersions ?? "/^[0-9]+\\.[0-9]+\\.[0-9]+$/");
    expect(yqAllowed.test(readYqPin(toolVersions).version)).toBe(true);
    expect(uvAllowed.test(readUvPin(toolVersions).version)).toBe(true);
    expect(yqAllowed.test("0.0.1-alpha.1")).toBe(false);
    expect(uvAllowed.test("0.0.1-alpha.1")).toBe(false);
  });

  test("a non-stable yq version fails coherence", () => {
    const yq = readYqPin(toolVersions);
    expect(() =>
      validateArchPin({
        ...yq,
        version: "0.0.1-alpha.1",
        amdTag: "v0.0.1-alpha.1",
        armTag: "v0.0.1-alpha.1",
        tagScheme: "v",
      })
    ).toThrow();
  });

  test("a yq version that does not match the tag fails coherence", () => {
    const yq = readYqPin(toolVersions);
    expect(() => validateArchPin({ ...yq, amdTag: "v0.0.2", tagScheme: "v" })).toThrow();
  });

  test("mismatched uv arch tags fail coherence", () => {
    const uv = readUvPin(toolVersions);
    expect(() => validateArchPin({ ...uv, armTag: "0.0.2", tagScheme: "bare" })).toThrow();
  });

  test("a short yq digest fails coherence", () => {
    const yq = readYqPin(toolVersions);
    expect(() => validateArchPin({ ...yq, amdSha: "a".repeat(63), tagScheme: "v" })).toThrow();
  });

  test("a non-hex uv digest fails coherence", () => {
    const uv = readUvPin(toolVersions);
    expect(() => validateArchPin({ ...uv, armSha: "Z".repeat(64), tagScheme: "bare" })).toThrow();
  });

  test("identical arch digests fail coherence", () => {
    const yq = readYqPin(toolVersions);
    expect(() => validateArchPin({ ...yq, armSha: yq.amdSha, tagScheme: "v" })).toThrow();
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
