import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "../..");
const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

// Pinned from the repositories' own CI: commandlinetools-linux-<n>_latest.zip.
const CMDLINE_TOOLS_VERSION = "11076708";
const CMDLINE_TOOLS_SHA256 = "2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258";

function stageAfter(docker: string, name: string): string {
  const start = docker.indexOf(`AS ${name}`);
  if (start === -1) return "";
  const next = docker.indexOf("\nFROM ", start + 1);
  return next === -1 ? docker.slice(start) : docker.slice(start, next);
}

describe("android sdk pin coherence", () => {
  test("tool-versions.env carries the cmdline-tools pin with SHA-256 and a renovate comment", () => {
    expect(toolVersions).toContain(`ANDROID_CMDLINE_TOOLS_VERSION=${CMDLINE_TOOLS_VERSION}`);
    expect(toolVersions).toContain(`ANDROID_CMDLINE_TOOLS_SHA256=${CMDLINE_TOOLS_SHA256}`);
    const versionLine = /^ANDROID_CMDLINE_TOOLS_VERSION=(?<v>[^\s]+)$/m.exec(toolVersions)?.groups?.v;
    expect(versionLine).toBe(CMDLINE_TOOLS_VERSION);
    const sha = /^ANDROID_CMDLINE_TOOLS_SHA256=(?<s>[^\s]+)$/m.exec(toolVersions)?.groups?.s;
    expect(sha).toBe(CMDLINE_TOOLS_SHA256);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(toolVersions).toMatch(/# renovate:.*\nANDROID_CMDLINE_TOOLS_VERSION=/);
  });
});

describe("android sdk build consumes one effective pin and fails closed", () => {
  test("Dockerfile takes the cmdline-tools pin as build-args with no baked default", () => {
    expect(dockerfile).toMatch(/^ARG ANDROID_CMDLINE_TOOLS_VERSION$/m);
    expect(dockerfile).toMatch(/^ARG ANDROID_CMDLINE_TOOLS_SHA256$/m);
    expect(dockerfile).not.toMatch(/^ARG ANDROID_CMDLINE_TOOLS_VERSION=/m);
    expect(dockerfile).not.toMatch(/^ARG ANDROID_CMDLINE_TOOLS_SHA256=/m);
    expect(dockerfile).toContain(
      ': "${ANDROID_CMDLINE_TOOLS_VERSION:?ANDROID_CMDLINE_TOOLS_VERSION build-arg is required}"'
    );
    expect(dockerfile).toContain(
      ': "${ANDROID_CMDLINE_TOOLS_SHA256:?ANDROID_CMDLINE_TOOLS_SHA256 build-arg is required}"'
    );
  });

  test("Dockerfile downloads the pinned cmdline-tools zip and verifies sha256", () => {
    expect(dockerfile).toContain(
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip"
    );
    expect(dockerfile).not.toContain("commandlinetools-linux-_latest");
    expect(dockerfile).toContain('echo "${ANDROID_CMDLINE_TOOLS_SHA256}  ${tmp_dir}/cmdtools.zip" | sha256sum -c -');
    expect(dockerfile).toContain("sdkmanager --licenses");
    expect(dockerfile).toContain('test -n "$(ls -A /opt/android-sdk/licenses)"');
  });

  test("Dockerfile has a dedicated cache-stable sdk stage", () => {
    expect(dockerfile).toMatch(/^FROM .* AS android-sdk$/m);
    const sdk = stageAfter(dockerfile, "android-sdk");
    expect(sdk).toContain("ANDROID_CMDLINE_TOOLS_VERSION");
    expect(sdk).toContain("sdkmanager");
    // The SDK layer must not depend on the per-release CLI versions.
    expect(sdk).not.toContain("OPENCODE_VERSION");
    expect(sdk).not.toContain("CLAUDE_VERSION");
    expect(sdk).not.toContain("CODEX_VERSION");
  });

  test("worker copies the sdk before the per-release layers and exposes the env", () => {
    const worker = stageAfter(dockerfile, "worker");
    expect(worker).toContain("COPY --from=android-sdk /opt/android-sdk /opt/android-sdk");
    expect(worker).toContain("ANDROID_HOME=/opt/android-sdk");
    expect(worker).toContain("ANDROID_SDK_ROOT=/opt/android-sdk");
    expect(worker).toContain("/opt/android-sdk/cmdline-tools/latest/bin");
    expect(worker).toContain("/opt/android-sdk/platform-tools");
    const sdkCopy = worker.indexOf("COPY --from=android-sdk");
    const implementCopy = worker.indexOf(".gitea/opencode-implement.json");
    expect(sdkCopy).toBeGreaterThanOrEqual(0);
    expect(implementCopy).toBeGreaterThanOrEqual(0);
    expect(sdkCopy).toBeLessThan(implementCopy);
    expect(worker).toContain("chmod -R a+rX /opt/android-sdk");
  });

  test("sdk package list is pinned with the platform and both build-tools", () => {
    expect(dockerfile).toMatch(/^ARG ANDROID_SDK_PACKAGES=/m);
    const packages = /^ARG ANDROID_SDK_PACKAGES=(?<p>.+)$/m.exec(dockerfile)?.groups?.p ?? "";
    expect(packages).toContain("platforms;android-37.0");
    expect(packages).toContain("build-tools;37.0.0");
    expect(packages).toContain("build-tools;36.0.0");
    expect(packages).toContain("platform-tools");
  });

  test("reviewer stage stays without the sdk", () => {
    const runtime = stageAfter(dockerfile, "runtime");
    expect(runtime).not.toContain("ANDROID_HOME");
    expect(runtime).not.toContain("android-sdk");
  });
});

describe("android sdk wiring", () => {
  test("workflows and build script pass the same pin without stripping it", () => {
    const paths = [
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
      ".gitea/scripts/build-worker-image.sh",
    ];
    for (const path of paths) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("ANDROID_CMDLINE_TOOLS_VERSION");
      expect(text).toContain("ANDROID_CMDLINE_TOOLS_SHA256");
    }
    for (const path of [".github/workflows/jumi-worker-image.yml", ".github/workflows/opencode-checks.yml"]) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("ANDROID_CMDLINE_TOOLS_VERSION=${{ env.ANDROID_CMDLINE_TOOLS_VERSION }}");
      expect(text).toContain("ANDROID_CMDLINE_TOOLS_SHA256=${{ env.ANDROID_CMDLINE_TOOLS_SHA256 }}");
      expect(text).toContain("grep -v '^#' .gitea/tool-versions.env >> $GITHUB_ENV");
    }
    const buildScript = readFileSync(join(repoRoot, ".gitea/scripts/build-worker-image.sh"), "utf8");
    expect(buildScript).toContain('"ANDROID_CMDLINE_TOOLS_VERSION=${ANDROID_CMDLINE_TOOLS_VERSION}"');
    expect(buildScript).toContain('"ANDROID_CMDLINE_TOOLS_SHA256=${ANDROID_CMDLINE_TOOLS_SHA256}"');
  });

  test("worker CI proves the baked sdk and reviewer CI refuses it", () => {
    const workerWorkflow = readFileSync(join(repoRoot, ".github/workflows/jumi-worker-image.yml"), "utf8");
    const checksWorkflow = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    for (const text of [workerWorkflow, checksWorkflow]) {
      expect(text).toContain('test -d "$ANDROID_HOME/platforms/android-37.0"');
      expect(text).toContain('test -d "$ANDROID_HOME/build-tools/37.0.0"');
      expect(text).toContain('ls -A "$ANDROID_HOME/licenses"');
      expect(text).toContain("sdkmanager --version");
      expect(text).toContain("--read-only");
      expect(text).toContain("--user 10001:10001");
      // The read-only probe still runs the image entrypoint, which writes the
      // secrets file to /tmp: production mounts pod /tmp as a memory emptyDir,
      // so CI mirrors it with a tmpfs while the SDK stays on the read-only root.
      expect(text).toContain("--tmpfs /tmp");
    }
    expect(checksWorkflow).toContain("reviewer image must not set ANDROID_HOME");
    const reviewerWorkflow = readFileSync(join(repoRoot, ".github/workflows/jumi-reviewer-image.yml"), "utf8");
    expect(reviewerWorkflow).toContain("reviewer image must not set ANDROID_HOME");
  });
});
