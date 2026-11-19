#!/usr/bin/env bun
/**
 * Repo lint: shellcheck, actionlint, zizmor, ruff.
 *
 * Pin source is `.gitea/tool-versions.env` (ACTIONLINT_*, SHELLCHECK_*,
 * ZIZMOR_VERSION, RUFF_VERSION). actionlint/shellcheck tarballs are fetched
 * from GitHub releases and verified fail-closed with `sha256sum -c` against
 * the pinned SHAs; ruff/zizmor run via `uvx <tool>@<version>` from PyPI
 * (verified by uv), so no per-arch SHA is pinned for them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function requireEnv(env: Record<string, string>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required in .gitea/tool-versions.env`);
  return value;
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {}
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  }
}

async function ensureBinary(opts: {
  name: string;
  version: string;
  url: string;
  sha256: string;
  archiveName: string;
  binPathInArchive: string;
}): Promise<string> {
  const cacheDir = join(tmpdir(), "jumi-repo-lint", `${opts.name}-${opts.version}`);
  const dest = join(cacheDir, opts.name);
  if (existsSync(dest)) return dest;
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, opts.archiveName);
  console.log(`downloading ${opts.name} ${opts.version} from ${opts.url}`);
  await run(["curl", "-fsSL", "--retry", "5", "--retry-delay", "5", "-o", archivePath, opts.url]);
  // Fail closed when the pinned SHA does not match the download.
  await run(["sh", "-c", `echo "${opts.sha256}  ${archivePath}" | sha256sum -c -`]);
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    if (opts.name === "shellcheck") {
      // shellcheck tar.gz contains a top-level `shellcheck-vX.Y.Z/shellcheck` file.
      await run(["tar", "-xzf", archivePath, "-C", cacheDir]);
      const { readdirSync } = await import("node:fs");
      for (const entry of readdirSync(cacheDir)) {
        const candidate = join(cacheDir, entry, opts.name);
        if (existsSync(candidate)) {
          await run(["install", "-m", "755", candidate, dest]);
          return dest;
        }
      }
      throw new Error(`could not find ${opts.name} binary in ${archivePath}`);
    }
    await run(["tar", "-xzf", archivePath, "-C", cacheDir, opts.binPathInArchive]);
  } else if (archivePath.endsWith(".tar.xz")) {
    await run(["tar", "-xJf", archivePath, "-C", cacheDir]);
    // shellcheck tar.xz contains a top-level `shellcheck-vX.Y.Z/shellcheck` file.
    const { readdirSync } = await import("node:fs");
    for (const entry of readdirSync(cacheDir)) {
      const candidate = join(cacheDir, entry, opts.name);
      if (existsSync(candidate)) {
        await run(["install", "-m", "755", candidate, dest]);
        return dest;
      }
    }
    throw new Error(`could not find ${opts.name} binary in ${archivePath}`);
  } else {
    throw new Error(`unsupported archive: ${archivePath}`);
  }
  // actionlint tar.gz contains the binary at the top level.
  if (!existsSync(dest)) {
    const extracted = join(cacheDir, opts.binPathInArchive);
    if (extracted !== dest && existsSync(extracted)) {
      await run(["install", "-m", "755", extracted, dest]);
    }
  }
  return dest;
}

const envFile = parseEnvFile(join(repoRoot, ".gitea", "tool-versions.env"));
const actionlintVersion = requireEnv(envFile, "ACTIONLINT_VERSION");
const shellcheckVersion = requireEnv(envFile, "SHELLCHECK_VERSION");
const zizmorVersion = requireEnv(envFile, "ZIZMOR_VERSION");
const ruffVersion = requireEnv(envFile, "RUFF_VERSION");

const arch = process.arch === "arm64" ? "arm64" : "amd64";
const actionlintSha =
  arch === "arm64" ? requireEnv(envFile, "ACTIONLINT_SHA256_ARM64") : requireEnv(envFile, "ACTIONLINT_SHA256_AMD64");
const shellcheckSha =
  arch === "arm64" ? requireEnv(envFile, "SHELLCHECK_SHA256_ARM64") : requireEnv(envFile, "SHELLCHECK_SHA256_AMD64");

const actionlintUrl = `https://github.com/rhysd/actionlint/releases/download/v${actionlintVersion}/actionlint_${actionlintVersion}_linux_${arch}.tar.gz`;
const shellArch = arch === "arm64" ? "aarch64" : "x86_64";
const shellcheckUrl = `https://github.com/koalaman/shellcheck/releases/download/v${shellcheckVersion}/shellcheck-v${shellcheckVersion}.linux.${shellArch}.tar.gz`;

const actionlintBin = await ensureBinary({
  name: "actionlint",
  version: actionlintVersion,
  url: actionlintUrl,
  sha256: actionlintSha,
  archiveName: `actionlint-${actionlintVersion}-${arch}.tar.gz`,
  binPathInArchive: "actionlint",
});

const shellcheckBin = await ensureBinary({
  name: "shellcheck",
  version: shellcheckVersion,
  url: shellcheckUrl,
  sha256: shellcheckSha,
  archiveName: `shellcheck-${shellcheckVersion}-${arch}.tar.gz`,
  binPathInArchive: "shellcheck",
});

console.log(`== shellcheck ${shellcheckVersion} (-S warning) ==`);
const hooksDir = join(repoRoot, "claude-plugins", "claude-code-tracing", "hooks");
const { readdirSync: readdirHooks } = await import("node:fs");
const hookFiles = readdirHooks(hooksDir)
  .filter((f) => f.endsWith(".sh"))
  .map((f) => join("claude-plugins", "claude-code-tracing", "hooks", f))
  .sort();
await run([
  shellcheckBin,
  "-S",
  "warning",
  "scripts/opencode/entrypoint.sh",
  ".gitea/scripts/build-reviewer-image.sh",
  ".gitea/scripts/build-worker-image.sh",
  ...hookFiles,
]);

console.log(`== actionlint ${actionlintVersion} ==`);
await run([actionlintBin]);

console.log(`== zizmor ${zizmorVersion} (--min-severity medium) ==`);
await run(["uvx", `zizmor@${zizmorVersion}`, "--min-severity", "medium", "--no-progress", ".github/workflows"]);

console.log(`== ruff ${ruffVersion} (--select F,B) ==`);
await run(["uvx", `ruff@${ruffVersion}`, "check", "--select", "F,B", "scripts/opencode/src"]);

console.log("repo lint passed");
