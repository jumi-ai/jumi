import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequirements, STABLE_SEMVER_RE } from "./tool_pin_helpers.ts";

const repoRoot = join(process.cwd(), "../..");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const requirements = readFileSync(join(repoRoot, "requirements.txt"), "utf8");

function readPythonPins(content: string) {
  const pins = parseRequirements(content);
  const pytest = pins["pytest"];
  const pyyaml = pins["pyyaml"];
  if (!pytest) throw new Error("missing pytest pin");
  if (!pyyaml) throw new Error("missing pyyaml pin");
  return { pytest, pyyaml };
}

describe("python 3.13 default with pytest and PyYAML", () => {
  test("Dockerfile links python3 and python into /usr/local/bin ahead of apt python", () => {
    expect(dockerfile).toContain('ln -sfn "${py_bin}" /usr/local/bin/python3.13');
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python3");
    expect(dockerfile).toContain("ln -sfn /usr/local/bin/python3.13 /usr/local/bin/python");
    expect(dockerfile).toMatch(/apt-get install.*python3 python-is-python3 python3-yaml/s);
  });

  test("requirements file pins pytest and PyYAML with ==", () => {
    const { pytest, pyyaml } = readPythonPins(requirements);
    expect(requirements).toMatch(/^pytest==\S+$/m);
    expect(requirements).toMatch(/^PyYAML==\S+$/m);
    expect(STABLE_SEMVER_RE.test(pytest)).toBe(true);
    expect(STABLE_SEMVER_RE.test(pyyaml)).toBe(true);
    expect(requirements).toContain(`pytest==${pytest}`);
    expect(requirements).toContain(`PyYAML==${pyyaml}`);
  });

  test("Dockerfile installs the pinned requirements into the 3.13 interpreter", () => {
    expect(dockerfile).toContain("COPY requirements.txt /tmp/requirements.txt");
    expect(dockerfile).toContain("--requirement /tmp/requirements.txt");
    expect(dockerfile).toContain("uv pip install --system");
    expect(dockerfile).toContain("--break-system-packages");
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

  test("an unpinned requirement fails coherence", () => {
    expect(() => readPythonPins("pytest\nPyYAML==0.0.1")).toThrow();
  });

  test("a non-semver requirement fails coherence", () => {
    const { pytest } = readPythonPins(requirements);
    expect(STABLE_SEMVER_RE.test("main")).toBe(false);
    expect(STABLE_SEMVER_RE.test(pytest)).toBe(true);
  });

  test("a missing PyYAML pin fails coherence", () => {
    expect(() => readPythonPins("pytest==0.0.1\n")).toThrow();
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
      expect(text).toContain("_http_post_json http://127.0.0.1:9 /tmp/jumi-post.json");
      expect(text).toContain("bash -c 'HOME=$(mktemp -d); . /app/claude-plugins/claude-code-tracing/hooks/common.sh;");
    }
  });

  test("tracing hooks stay on the stdlib under the new python3", () => {
    const common = readFileSync(join(repoRoot, "claude-plugins/claude-code-tracing/hooks/common.sh"), "utf8");
    expect(common).toContain("urllib.request");
    expect(common).toContain("import os");
    expect(common).not.toMatch(/import (yaml|pytest|requests|opentelemetry)/);
  });
});
