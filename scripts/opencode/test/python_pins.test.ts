import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(process.cwd(), "../..");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const requirements = readFileSync(join(repoRoot, "requirements.txt"), "utf8");

const PYTEST_PIN = "pytest==9.2.0";
const PYYAML_PIN = "PyYAML==6.0.3";

describe("python 3.13 default with pytest and PyYAML", () => {
  test("Dockerfile links python3 and python into /usr/local/bin ahead of apt python", () => {
    expect(dockerfile).toContain('ln -sfn "${py_bin}" /usr/local/bin/python3.13');
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python3");
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python");
    // The apt Debian Python stays installed for system packages but is not first on PATH.
    expect(dockerfile).toMatch(/apt-get install.*python3 python-is-python3 python3-yaml/s);
  });

  test("requirements file pins pytest and PyYAML with ==", () => {
    expect(requirements).toContain(PYTEST_PIN);
    expect(requirements).toContain(PYYAML_PIN);
    expect(requirements).toMatch(/^pytest==\S+$/m);
    expect(requirements).toMatch(/^PyYAML==\S+$/m);
  });

  test("Dockerfile installs the pinned requirements into the 3.13 interpreter", () => {
    expect(dockerfile).toContain("COPY requirements.txt /tmp/requirements.txt");
    expect(dockerfile).toContain("--requirement /tmp/requirements.txt");
    expect(dockerfile).toContain("uv pip install --system");
    expect(dockerfile).toContain("uv python install 3.13 --install-dir /opt/cpython --no-bin");
  });

  test("Dockerfile final check asserts the version and the modules", () => {
    expect(dockerfile).toContain("python3 -c 'import sys; assert sys.version_info[:2] == (3, 13)'");
    expect(dockerfile).toContain("python -c 'import sys; assert sys.version_info[:2] == (3, 13)'");
    expect(dockerfile).toContain("python3 -m pytest --version");
    expect(dockerfile).toContain("python3 -c 'import yaml, pytest'");
    expect(dockerfile).toContain('filter="data"');
    expect(dockerfile).toContain("UV_OFFLINE=1 uv run --no-project --python 3.13 python -V");
  });

  test("image CI fails on a version or module mismatch and exercises the hook POST path", () => {
    const paths = [
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
    ];
    for (const path of paths) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      expect(text).toContain("import sys; assert sys.version_info[:2] == (3, 13)");
      expect(text).toContain("python3 -m pytest --version");
      expect(text).toContain("import yaml, pytest");
      expect(text).toContain('filter="data"');
      // The tracing hooks POST through python3 stdlib; the POST path runs once under the new interpreter.
      expect(text).toContain("_http_post_json http://127.0.0.1:9 /tmp/jumi-post.json");
    }
  });

  test("tracing hooks stay on the stdlib under the new python3", () => {
    const common = readFileSync(join(repoRoot, "claude-plugins/claude-code-tracing/hooks/common.sh"), "utf8");
    expect(common).toContain("urllib.request");
    expect(common).toContain("import os");
    expect(common).not.toMatch(/import (yaml|pytest|requests|opentelemetry)/);
  });
});
