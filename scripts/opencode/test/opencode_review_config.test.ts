import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORGE_DENY_DOMAIN,
  forgeOpenCodeConfigContent,
  forgeOpenCodeGlobalConfig,
  forgePermissions,
  isPermissionDenyText,
} from "../src/forge_webfetch.ts";

type Effect = "allow" | "ask" | "deny";

interface OpenCodeReviewConfig {
  model?: unknown;
  small_model?: unknown;
  plugins?: unknown;
  experimental?: { hook?: unknown };
  providers?: {
    xai?: {
      models?: Record<string, { settings?: { reasoningEffort?: unknown } }>;
    };
    openai?: {
      models?: Record<string, { settings?: { reasoningEffort?: unknown } }>;
    };
  };
  skills?: string[];
  websearch?: unknown;
  permissions: { action: string; resource: string; effect: Effect }[];
}

// No local matcher lives here on purpose. Whether a pattern actually denies a
// URL is proved against the installed OpenCode binary by
// `src/webfetch_probe.ts`, which every image verification path runs; a copy of
// OpenCode's wildcard matcher would only grade itself. These tests assert the
// shape and last-match ordering of the maps we ship.

describe("opencode review config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-review.json"), "utf8")
  ) as OpenCodeReviewConfig;
  const rulesFor = (action: string) => config.permissions.filter((rule) => rule.action === action);
  const defaultFor = (action: string) => {
    const rules = rulesFor(action);
    expect(rules.map((rule) => rule.resource)).toEqual(["*"]);
    return rules[0]?.effect;
  };

  test("keeps model selection remote while pinning reviewer reasoning high", () => {
    expect(config.model).toBeUndefined();
    expect(config.small_model).toBeUndefined();
    expect(config.providers?.xai?.models?.["grok-4.5"]?.settings?.reasoningEffort).toBe("high");
    expect(config.providers?.xai?.models?.["grok-4.6"]?.settings?.reasoningEffort).toBe("high");
    expect(config.providers?.openai?.models?.["gpt-5.5"]?.settings?.reasoningEffort).toBe("high");
  });

  test("uses only OpenCode 2 config keys", () => {
    const keys = Object.keys(config);
    for (const v1 of ["autoupdate", "snapshot", "provider", "permission", "plugin"]) expect(keys).not.toContain(v1);
  });

  test("names a web search provider, because a headless run exits 1 without one", () => {
    expect(config.websearch).toEqual({ provider: "exa" });
  });

  test("allows edit for JUMI_REVIEW.md while keeping other mutation-oriented tools denied", () => {
    expect(defaultFor("webfetch")).toBe("allow");
    expect(defaultFor("websearch")).toBe("allow");
    expect(defaultFor("edit")).toBe("allow");
    expect(defaultFor("subagent")).toBe("deny");
    expect(defaultFor("todowrite")).toBe("deny");
    expect(defaultFor("question")).toBe("deny");
  });

  test("allows every skill the reviewer can discover: image, fleet, and checkout", () => {
    // No named allow-list: the model only sees a description until it loads one.
    expect(defaultFor("skill")).toBe("allow");
    // Image pack, then fleet OpenCode skills under the real HOME (the sanitized
    // spawn points XDG_CONFIG_HOME at a scratch dir). Checkout roots and fleet
    // `.claude/skills` / `.agents/skills` are OpenCode's own scans.
    expect(config.skills).toEqual(["/app/review-skills", "~/.config/opencode/skill", "~/.config/opencode/skills"]);
  });

  test("brings no hooks or plugins of its own", () => {
    // Plugins and hooks are the repository's to bring, not this config's.
    expect(config.plugins).toBeUndefined();
    expect(config.experimental?.hook).toBeUndefined();
  });

  test("denies webfetch to homelab Gitea and GitHub search after star allow (last-match)", () => {
    const rules = forgePermissions(FORGE_DENY_DOMAIN);
    expect(JSON.parse(forgeOpenCodeConfigContent(FORGE_DENY_DOMAIN))).toEqual({ permissions: rules });
    expect(rules).toEqual([
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*kirmanak.stream*", effect: "deny" },
      { action: "webfetch", resource: "*github.com/search*", effect: "deny" },
    ]);
  });

  test("the forge policy outranks a repository by living in the global config", () => {
    expect(JSON.parse(forgeOpenCodeGlobalConfig(FORGE_DENY_DOMAIN))).toEqual({
      policies: [
        { action: "tool.use", resource: `webfetch:*${FORGE_DENY_DOMAIN}*`, effect: "deny" },
        { action: "tool.use", resource: "webfetch:*github.com/search*", effect: "deny" },
      ],
    });
  });

  test("the binary probe drives the shipped map rather than a copy of it", () => {
    const probe = readFileSync(join(process.cwd(), "src/webfetch_probe.ts"), "utf8");
    expect(probe).toContain('from "./forge_webfetch.ts"');
    expect(probe).toContain("forgeOpenCodeConfigContent(FORGE_DENY_DOMAIN)");
    expect(probe).toContain("forgePermissions(FORGE_DENY_DOMAIN)");
    // Deny of the forge host and allow of an unrelated host, both on the binary.
    expect(probe).toContain('expect: "allow"');
    expect(probe).toContain('expect: "deny"');
    expect(probe).toContain("https://gitea.kirmanak.stream/");
    expect(probe).toContain("github.com/search");
    // The deny assertion reads the shipped matcher, so it cannot drift from it.
    expect(probe).toContain("isPermissionDenyText(result)");
    // Image jobs start the probe from another directory, and OpenCode 2 prefers
    // PWD over cwd, so without this the relative skill roots miss the workspace.
    expect(probe).toContain("PWD: workdir");
    // The deny has to hold against a repository trying to lift it.
    expect(probe).toContain("forgeOpenCodeGlobalConfig(FORGE_DENY_DOMAIN)");
    expect(probe).toContain("agents: { build: { permissions: allow } }");
  });

  test("allows Read of image and fleet skill dirs after star deny (last-match)", () => {
    // OpenCode expands `~/` against the spawn's HOME, where fleet skills live.
    const rules = rulesFor("external_directory");
    expect(rules.map((rule) => rule.resource)).toEqual([
      "*",
      "/app/review-skills/**",
      "~/.claude/skills/**",
      "~/.agents/skills/**",
      "~/.config/opencode/skill/**",
      "~/.config/opencode/skills/**",
    ]);
    expect(rules[0]?.effect).toBe("deny");
    for (const rule of rules.slice(1)) expect(rule.effect).toBe("allow");
  });

  test("defaults shell to allow with no commit/push carve-outs", () => {
    expect(defaultFor("shell")).toBe("allow");
  });
});

describe("reviewer image permissions", () => {
  const repoRoot = join(process.cwd(), "../..");
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const skillPath = join(repoRoot, "review-skills/gitops-apply-review/SKILL.md");

  test("does not chown /app to the reviewer uid", () => {
    expect(dockerfile).not.toMatch(/chown\s+-R\s+jumi:jumi\s+\/app/);
    expect(dockerfile).toMatch(/chown\s+-R\s+jumi:jumi\s+\/data\s+\/work/);
  });

  test("copies gitops-apply-review into the image layout the config points at", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("name: gitops-apply-review");
    expect(dockerfile).toContain("COPY review-skills /app/review-skills");
  });

  test("copies gitea-pull-review into the same image pack", () => {
    const giteaSkillPath = join(repoRoot, "review-skills/gitea-pull-review/SKILL.md");
    expect(existsSync(giteaSkillPath)).toBe(true);
    expect(readFileSync(giteaSkillPath, "utf8")).toContain("name: gitea-pull-review");
  });

  test("runs the webfetch permission probe on the binary in every image verification path", () => {
    // The probe is the only thing standing between an OpenCode upgrade and a
    // silently dropped forge-host deny, so no verification path may lose it.
    // `opencode-checks.yml` matters most: it is the one that runs on
    // pull_request, so it is what gates an OPENCODE_VERSION bump before the
    // image is published.
    const paths = [
      ".gitea/scripts/build-reviewer-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/opencode-checks.yml",
    ];
    expect(existsSync(join(repoRoot, "scripts/opencode/src/webfetch_probe.ts"))).toBe(true);
    for (const path of paths) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/webfetch_probe.ts");
    }
    // src/ is what carries the probe (and the map it imports) into the image.
    expect(dockerfile).toContain("COPY scripts/opencode/src ./src");
  });

  test("runs the quota probe on the binary in every image verification path", () => {
    // The quota reads swallow SQLite errors, so this is what stops an OpenCode
    // upgrade from silently turning quota sleeps into job timeouts.
    expect(existsSync(join(repoRoot, "scripts/opencode/src/quota_probe.ts"))).toBe(true);
    for (const path of [
      ".gitea/scripts/build-reviewer-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/opencode-checks.yml",
    ]) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/quota_probe.ts");
    }
  });

  test("installs python3 and helm in the runtime image", () => {
    expect(dockerfile).toMatch(/python3/);
    expect(dockerfile).toMatch(/python3 --version/);
    expect(dockerfile).toMatch(/helm version --short/);
    expect(dockerfile).toMatch(/get\.helm\.sh\/helm-v\$\{HELM_VERSION\}/);
    expect(dockerfile).not.toMatch(/kubectl/);
  });

  test("pulls base images from Docker Hub", () => {
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim(?:@sha256:[0-9a-f]+)? AS tools/);
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim(?:@sha256:[0-9a-f]+)? AS runtime/);
    expect(dockerfile).toMatch(/github\.com\/oven-sh\/bun\/releases\/download\/bun-v\$\{BUN_VERSION\}/);
    expect(dockerfile).not.toMatch(/oven\/bun/);
    expect(dockerfile).not.toMatch(/public\.ecr\.aws/);
    expect(dockerfile).not.toMatch(/^FROM debian:/m);
    expect(dockerfile).not.toMatch(/^FROM eclipse-temurin:/m);
  });
});

describe("worker image JDK", () => {
  const repoRoot = join(process.cwd(), "../..");
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const workerStage = dockerfile.slice(dockerfile.indexOf("FROM runtime AS worker"));
  const beforeWorker = dockerfile.slice(0, dockerfile.indexOf("FROM runtime AS worker"));

  test("copies pinned Temurin 21 into the worker target only", () => {
    expect(dockerfile).toContain("ARG TEMURIN_TAG=21.0.12_8-jdk");
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/eclipse-temurin:\$\{TEMURIN_TAG\} AS jdk/);
    expect(dockerfile).toMatch(/FROM tools AS build/);
    expect(dockerfile).toMatch(/oven-sh\/bun\/releases\/download\/bun-v\$\{BUN_VERSION\}/);
    expect(dockerfile).not.toMatch(/FROM oven\/bun/);
    expect(workerStage).toContain("COPY --from=jdk /opt/java/openjdk /opt/java/openjdk");
    expect(workerStage).toContain("JAVA_HOME=/opt/java/openjdk");
    expect(beforeWorker).not.toContain("COPY --from=jdk");
    expect(beforeWorker).not.toContain("JAVA_HOME=");
  });

  test("inherits the baked skill pack and points OpenCode at implement config", () => {
    expect(beforeWorker).toContain("COPY review-skills /app/review-skills");
    expect(workerStage).toContain("OPENCODE_CONFIG=/app/.gitea/opencode-implement.json");
    expect(workerStage).toContain("COPY .gitea/opencode-implement.json /app/.gitea/opencode-implement.json");
  });

  test("does not pull debian, bun, or temurin via Docker Hub short names", () => {
    expect(dockerfile).not.toMatch(/^FROM debian:/m);
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m);
    expect(dockerfile).not.toMatch(/^FROM eclipse-temurin:/m);
    expect(dockerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim(?:@sha256:[0-9a-f]+)? AS tools/);
    expect(dockerfile).toMatch(/bun-v\$\{BUN_VERSION\}\/bun-\$\{bun_platform\}\.zip/);
  });
});

describe("renovate bun pin", () => {
  const repoRoot = join(process.cwd(), "../..");
  const renovateRaw = readFileSync(join(repoRoot, "renovate.json"), "utf8");
  const renovate = JSON.parse(renovateRaw) as {
    constraints?: Record<string, string>;
    customManagers?: { managerFilePatterns?: string[]; matchStrings?: string[]; depNameTemplate?: string }[];
    packageRules?: { matchPackageNames?: string[]; extractVersion?: string }[];
  };
  const toolVersions = readFileSync(join(repoRoot, ".gitea/tool-versions.env"), "utf8");
  const pinnedBun = toolVersions.match(/^BUN_VERSION=(.+)$/m)?.[1];
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

  test("runs lockFileMaintenance on the same bun every consumer is pinned to", () => {
    // Without this, Renovate regenerates scripts/opencode/bun.lock with its own
    // (newer) bun, which writes `lockfileVersion: 2`. BUN_VERSION cannot read
    // that -- it aborts with `UnknownLockfileVersion` at bun.lock:2:22, warns
    // `Ignoring lockfile`, and then fails the frozen check, taking out every
    // workflow job and the Dockerfile install layer. Only `lockfileVersion`
    // does this; the `configVersion` key newer bun also writes parses fine
    // under 1.2.5 and is absent here merely because 1.2.5 does not emit it.
    expect(pinnedBun).toBeTruthy();
    expect(renovate.constraints?.bun).toBe(pinnedBun);
  });

  test("keeps the Dockerfile from carrying a third copy of the pin", () => {
    // build-worker-image.sh and build-reviewer-image.sh both require
    // BUN_VERSION and pass --build-arg, so a default here is only ever reached
    // by a bare `docker build .` -- and now that extractVersion lets Renovate
    // move BUN_VERSION, it would go stale the way HELM_VERSION already has.
    // Bare ARG makes such a build fail at the bun download instead of quietly
    // installing against a lockfile another bun generated.
    expect(dockerfile).toMatch(/^ARG BUN_VERSION$/m);
    expect(dockerfile).not.toMatch(/^ARG BUN_VERSION=/m);
    expect(dockerfile).toMatch(/^ARG OPENCODE_VERSION$/m);
    expect(dockerfile).not.toMatch(/^ARG OPENCODE_VERSION=/m);
    expect(dockerfile).toMatch(/^ARG CLAUDE_VERSION$/m);
    expect(dockerfile).not.toMatch(/^ARG CLAUDE_VERSION=/m);
    expect(dockerfile).toMatch(/^ARG HELM_VERSION$/m);
    expect(dockerfile).not.toMatch(/^ARG HELM_VERSION=/m);
  });

  test("lets Renovate bump constraints.bun so the pin above is not hand-maintained", () => {
    // The assertion above is a tripwire: a PR that moves BUN_VERSION alone turns
    // it red, and patch updates automerge with ignoreTests: false, so such a PR
    // would block until someone edited renovate.json inside the Renovate branch.
    // This custom manager makes both move in one PR instead.
    const manager = renovate.customManagers?.find((m) => m.managerFilePatterns?.includes("/^renovate\\.json$/"));
    expect(manager?.depNameTemplate).toBe("oven-sh/bun");
    const matchString = manager?.matchStrings?.[0];
    expect(matchString).toBeTruthy();
    expect(new RegExp(matchString ?? "").exec(renovateRaw)?.groups?.currentValue).toBe(pinnedBun);
  });

  test("strips the bun-v tag prefix so BUN_VERSION can be bumped at all", () => {
    // oven-sh/bun tags releases `bun-v1.2.5`; github-releases only strips a
    // leading `v`, so without extractVersion every candidate is discarded as
    // non-semver and the pin above silently freezes forever.
    const rule = renovate.packageRules?.find((r) => r.matchPackageNames?.includes("oven-sh/bun"));
    expect(rule?.extractVersion).toBe("^bun-v(?<version>.+)$");
    expect(new RegExp(rule?.extractVersion ?? "").exec("bun-v1.2.5")?.groups?.version).toBe("1.2.5");
  });
});

describe("isPermissionDenyText", () => {
  test("matches the Permission denied prefix", () => {
    expect(
      isPermissionDenyText("Permission denied: webfetch is not allowed for https://gitea.kirmanak.stream/foo")
    ).toBe(true);
    expect(isPermissionDenyText("permission denied: tool execution forbidden")).toBe(true);
    expect(isPermissionDenyText("Blocked by configuration policy")).toBe(true);
  });

  test("does not match unrelated errors or non-string input", () => {
    expect(isPermissionDenyText("404 Not Found")).toBe(false);
    expect(isPermissionDenyText("Connection refused")).toBe(false);
    expect(isPermissionDenyText("Permission denied")).toBe(false);
    expect(isPermissionDenyText("Permission denied:")).toBe(false);
    expect(isPermissionDenyText("")).toBe(false);
    expect(isPermissionDenyText(null)).toBe(false);
    expect(isPermissionDenyText(undefined)).toBe(false);
    expect(isPermissionDenyText(123)).toBe(false);
    expect(isPermissionDenyText({ error: "denied" })).toBe(false);
  });
});
