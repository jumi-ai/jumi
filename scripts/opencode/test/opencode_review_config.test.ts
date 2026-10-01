import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_DENY_DOMAIN, forgeOpenCodePermission, forgeWebfetchPermission } from "../src/forge_webfetch.ts";

interface OpenCodeReviewConfig {
  model?: unknown;
  small_model?: unknown;
  plugin?: unknown;
  experimental?: { hook?: unknown };
  enabled_providers?: unknown;
  skills?: { paths?: string[] };
  provider?: {
    xai?: {
      models?: Record<string, { options?: { reasoningEffort?: unknown } }>;
    };
    openai?: {
      models?: Record<string, { options?: { reasoningEffort?: unknown } }>;
    };
  };
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    webfetch: "allow" | "ask" | "deny";
    websearch: "allow" | "ask" | "deny";
    edit: "allow" | "ask" | "deny";
    write: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    lsp: "allow" | "ask" | "deny";
    skill: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    question: "allow" | "ask" | "deny";
    doom_loop: "allow" | "ask" | "deny";
  };
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

  test("keeps model selection remote while pinning reviewer reasoning high", () => {
    expect(config.model).toBeUndefined();
    expect(config.small_model).toBeUndefined();
    expect(config.enabled_providers).toBeUndefined();
    expect(config.provider?.xai?.models?.["grok-4.5"]?.options?.reasoningEffort).toBe("high");
    expect(config.provider?.xai?.models?.["grok-4.6"]?.options?.reasoningEffort).toBe("high");
    expect(config.provider?.openai?.models?.["gpt-5.5"]?.options?.reasoningEffort).toBe("high");
  });

  test("allows edit/write for JUMI_REVIEW.md while keeping other mutation-oriented tools denied", () => {
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.websearch).toBe("allow");
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.write).toBe("allow");
    expect(config.permission.lsp).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.question).toBe("deny");
    expect(config.permission.doom_loop).toBe("deny");
  });

  test("allows every skill the reviewer can discover: image, fleet, and checkout", () => {
    // No named allow-list: the model only sees a description until it loads one.
    expect(config.permission.skill).toBe("allow");
    // Image pack, checkout `.opencode/skill(s)` (relative paths resolve against
    // `--dir`, and the sanitized spawn keeps project config off, so these are
    // the only way they load), and fleet OpenCode skills under the real HOME
    // (the sanitized spawn points XDG_CONFIG_HOME at a scratch dir). Checkout
    // and fleet `.claude/skills` / `.agents/skills` are OpenCode's own scans.
    expect(config.skills?.paths).toEqual([
      "/app/review-skills",
      ".opencode/skill",
      ".opencode/skills",
      "~/.config/opencode/skill",
      "~/.config/opencode/skills",
    ]);
  });

  test("brings no hooks or plugins of its own", () => {
    // Checkout plugins stay off because the review spawn sets
    // OPENCODE_DISABLE_PROJECT_CONFIG (test/git.test.ts); this config must not
    // add a plugin or command hook back.
    expect(config.plugin).toBeUndefined();
    expect(config.experimental?.hook).toBeUndefined();
  });

  test("denies webfetch to homelab Gitea and GitHub search after star allow (last-match)", () => {
    const rules = forgeWebfetchPermission(FORGE_DENY_DOMAIN);
    expect(JSON.parse(forgeOpenCodePermission(FORGE_DENY_DOMAIN))).toEqual({ webfetch: rules });
    expect(rules).toEqual({
      "*": "allow",
      "*kirmanak.stream*": "deny",
      "*github.com/search*": "deny",
    });
    expect(Object.keys(rules)).toEqual(["*", "*kirmanak.stream*", "*github.com/search*"]);
  });

  test("the binary probe drives the shipped map rather than a copy of it", () => {
    const probe = readFileSync(join(process.cwd(), "src/webfetch_probe.ts"), "utf8");
    expect(probe).toContain('from "./forge_webfetch.ts"');
    expect(probe).toContain("forgeOpenCodePermission(FORGE_DENY_DOMAIN)");
    expect(probe).toContain("forgeWebfetchPermission(FORGE_DENY_DOMAIN)");
    // Deny of the forge host and allow of an unrelated host, both on the binary.
    expect(probe).toContain('expect: "allow"');
    expect(probe).toContain('expect: "deny"');
    expect(probe).toContain("https://gitea.kirmanak.stream/");
    expect(probe).toContain("github.com/search");
    // The deny assertion reads the shipped map, so it cannot drift from it.
    expect(probe).toContain("DENY_PATTERNS");
  });

  test("allows Read of image and fleet skill dirs after star deny (last-match)", () => {
    // OpenCode expands `~/` against the spawn's HOME, where fleet skills live.
    const rules = config.permission.external_directory;
    if (typeof rules === "string") throw new Error("expected last-match object, not scalar deny");
    expect(Object.keys(rules)).toEqual([
      "*",
      "/app/review-skills/**",
      "~/.claude/skills/**",
      "~/.agents/skills/**",
      "~/.config/opencode/skill/**",
      "~/.config/opencode/skills/**",
    ]);
    expect(rules["*"]).toBe("deny");
    for (const [pattern, action] of Object.entries(rules)) {
      if (pattern !== "*") expect(action).toBe("allow");
    }
  });

  test("defaults bash to allow with no commit/push carve-outs", () => {
    const bash = config.permission.bash;
    expect(bash["*"]).toBe("allow");
    expect(Object.keys(bash)).toEqual(["*"]);
    expect(Object.keys(bash).some((pattern) => /git commit|git push/i.test(pattern))).toBe(false);
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
