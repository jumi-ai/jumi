import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advertisedNextVersion,
  buildReleaseBody,
  classifyBump,
  computeRelease,
  contractEnvIssues,
  formatContractEnvIssue,
  gitOpsLoaderEnv,
  nextVersionFrom,
  parseContract,
  parseSemVerTag,
  peeledCommitForTag,
  publishGitHubRelease,
  publishRelease,
  runPublishGitHub,
  shouldSkipImageBuild,
  touchesGitHubWorkflows,
  workflowRebuildsOnTag,
} from "../src/release.ts";
import { ANTIGRAVITY_HOMELAB_CONSTRAINT } from "../src/runners.ts";

const repoRoot = join(process.cwd(), "../..");

const BASE_CONTRACT = `# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`
- \`GITEA_BOT_TOKEN\`
- \`GITEA_WEBHOOK_SECRET\`

#### gitops env

#### optional env

#### ports
- \`3000\`

#### runAs
- \`10001:10001\`

#### probes
- \`GET /healthz port 3000\`

#### command
- \`bun run src/server.ts\`

#### image target
- \`runtime\`

#### volumes
- \`/data\`
- \`/work\`

### worker

#### required env
- \`GITEA_URL\`
- \`GITEA_BOT_TOKEN\`
- \`GITEA_WEBHOOK_SECRET\`

#### gitops env

#### optional env

#### ports
- \`3000\`

#### runAs
- \`10001:10001\`

#### probes
- \`GET /healthz port 3000\`

#### command
- \`bun run src/worker_server.ts\`

#### image target
- \`worker\`

#### volumes
- \`/data\`
- \`/work\`
`;

function addListItem(contract: string, image: "reviewer" | "worker", heading: string, value: string): string {
  const headingIdx = contract.indexOf(`#### ${heading}`, contract.indexOf(`### ${image}`));
  const insertAt = contract.indexOf("\n", headingIdx) + 1;
  return `${contract.slice(0, insertAt)}- \`${value}\`\n${contract.slice(insertAt)}`;
}

function addRequiredEnv(contract: string, image: "reviewer" | "worker", key: string): string {
  return addListItem(contract, image, "required env", key);
}

function removeRequiredEnv(contract: string, key: string): string {
  return contract.replace(`- \`${key}\`\n`, "");
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

async function withRepo(setup: (dir: string) => Promise<void>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-release-"));
  try {
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "jumi@example.com"], dir);
    git(["config", "user.name", "jumi"], dir);
    git(["config", "commit.gpgsign", "false"], dir);
    await setup(dir);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("version bump", () => {
  test("no tag → v1.0.0 and GitOps none", () => {
    expect(classifyBump(null, BASE_CONTRACT)).toBe("initial");
    expect(nextVersionFrom(null, "initial")).toBe("v1.0.0");
    const body = buildReleaseBody({
      previousContract: null,
      currentContract: BASE_CONTRACT,
      changes: ["abc1234 baseline"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("## Breaking\nnone\n");
    expect(body).toContain("## Changes\n- abc1234 baseline\n");
  });

  test("unchanged contract → patch", () => {
    expect(classifyBump(BASE_CONTRACT, BASE_CONTRACT)).toBe("patch");
    expect(nextVersionFrom("v1.2.3", "patch")).toBe("v1.2.4");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: BASE_CONTRACT,
      changes: ["def5678 fix queue"],
    });
    expect(body).toMatch(/^## GitOps\nnone\n\n## Breaking\nnone\n\n## Changes\n/m);
    expect(body).toContain("- def5678 fix queue");
  });

  test("additive required env → major with namespaced GitOps bullets", () => {
    const next = addRequiredEnv(BASE_CONTRACT, "reviewer", "FOO");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    expect(nextVersionFrom("v1.0.0", "major")).toBe("v2.0.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["aaa1111 add FOO"],
    });
    expect(body).toContain(
      "## GitOps\n### reviewer\n- **requires** `FOO` (new; missing → crash)\n### worker\n- none\n"
    );
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive optional volume → minor", () => {
    const next = addListItem(BASE_CONTRACT, "worker", "volumes", "/var/cache");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("minor");
    expect(nextVersionFrom("v1.0.0", "minor")).toBe("v1.1.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ddd4444 add cache volume"],
    });
    expect(body).toContain("### worker\n- **volume** `/var/cache` (new)\n");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive optional env → minor with GitOps bullets", () => {
    const next = addListItem(BASE_CONTRACT, "worker", "optional env", "MAX_FOLLOWUP_ROUNDS");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("minor");
    expect(nextVersionFrom("v1.0.0", "minor")).toBe("v1.1.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["hhh8888 follow-up cap env"],
    });
    expect(body).toContain("### worker\n- **optional env** `MAX_FOLLOWUP_ROUNDS` (new)\n");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive port → major", () => {
    const next = addListItem(BASE_CONTRACT, "reviewer", "ports", "9090");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["eee5555 add metrics port"],
    });
    expect(body).toContain("**port** `9090` (new)");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("removed required key → major", () => {
    const next = removeRequiredEnv(BASE_CONTRACT, "GITEA_WEBHOOK_SECRET");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    expect(nextVersionFrom("v1.4.2", "major")).toBe("v2.0.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["bbb2222 drop webhook secret"],
    });
    expect(body).toContain("**removed** `GITEA_WEBHOOK_SECRET`");
    expect(body).toContain("removed required env GITEA_WEBHOOK_SECRET");
  });

  test("required constraint add or removal → major", () => {
    const heading = "#### required constraints\n- `Antigravity refused unless FORGE=github`\n\n";
    const withReviewer = BASE_CONTRACT.replace("### reviewer\n", `### reviewer\n${heading}`);
    expect(classifyBump(BASE_CONTRACT, withReviewer)).toBe("major");
    const added = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: withReviewer,
      changes: ["agy1111 refuse homelab antigravity"],
    });
    expect(added).toContain("**constraint** `Antigravity refused unless FORGE=github`");
    expect(added).toContain("## Breaking\nnone\n");

    const removed = buildReleaseBody({
      previousContract: withReviewer,
      currentContract: BASE_CONTRACT,
      changes: ["agy2222 drop constraint"],
    });
    expect(classifyBump(withReviewer, BASE_CONTRACT)).toBe("major");
    expect(removed).toContain("**removed constraint** `Antigravity refused unless FORGE=github`");
    expect(removed).toContain("reviewer: removed required constraint Antigravity refused unless FORGE=github");
  });

  test("BREAKING marker → major even without key removal", () => {
    const next = `${BASE_CONTRACT}\n## BREAKING\n- app protocol change\n`;
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ccc3333 break api"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("- BREAKING marker in deploy/contract.md");
  });

  test("reviewer and worker share one version", () => {
    const reviewerOnly = addRequiredEnv(BASE_CONTRACT, "reviewer", "FOO");
    const workerOnly = addRequiredEnv(BASE_CONTRACT, "worker", "BAR");
    const volumeOnly = addListItem(BASE_CONTRACT, "worker", "volumes", "/var/cache");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, reviewerOnly))).toBe("v2.0.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, workerOnly))).toBe("v2.0.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, volumeOnly))).toBe("v1.1.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, BASE_CONTRACT))).toBe("v1.0.1");
  });

  test("gitops env is GitOps-required (major) but does not claim crash", () => {
    const next = addListItem(BASE_CONTRACT, "worker", "gitops env", "DATABASE_URL");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["fff6666 worker DATABASE_URL"],
    });
    expect(body).toContain(
      "### worker\n- **requires** `DATABASE_URL` (new; GitOps must set; unset → local/dev, no crash)\n"
    );
    expect(body).not.toContain("(new; missing → crash)");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("moving env between required and gitops env is patch; chart still sets it", () => {
    const required = addRequiredEnv(BASE_CONTRACT, "worker", "DATABASE_URL");
    const gitOps = addListItem(BASE_CONTRACT, "worker", "gitops env", "DATABASE_URL");
    expect(classifyBump(required, gitOps)).toBe("patch");
    expect(classifyBump(gitOps, required)).toBe("patch");
    const relaxed = buildReleaseBody({ previousContract: required, currentContract: gitOps, changes: ["x"] });
    expect(relaxed).toContain(
      "### worker\n- **process start** `DATABASE_URL` no longer fails when unset (GitOps must still set it)\n"
    );
    expect(relaxed).toContain("## Breaking\nnone\n");
    const tightened = buildReleaseBody({ previousContract: gitOps, currentContract: required, changes: ["x"] });
    expect(tightened).toContain(
      "### worker\n- **process start** `DATABASE_URL` now fails when unset (was GitOps-only)\n"
    );
  });

  test("removed gitops env → major and Breaking", () => {
    const gitOps = addListItem(BASE_CONTRACT, "worker", "gitops env", "DATABASE_URL");
    expect(classifyBump(gitOps, BASE_CONTRACT)).toBe("major");
    const body = buildReleaseBody({ previousContract: gitOps, currentContract: BASE_CONTRACT, changes: ["x"] });
    expect(body).toContain("- worker: removed required env DATABASE_URL");
  });

  test("prose-only contract notes stay patch with GitOps none", () => {
    const next = `${BASE_CONTRACT}\nNotes changed without keys.\n`;
    expect(classifyBump(BASE_CONTRACT, next)).toBe("patch");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ggg7777 notes"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("## Breaking\nnone\n");
  });
});

describe("deploy/contract.md", () => {
  test("parses live contract from origin/main intent", async () => {
    const markdown = await readFile(join(repoRoot, "deploy/contract.md"), "utf8");
    const parsed = parseContract(markdown);
    expect(parsed.reviewer.requiredEnv).toEqual([
      "GITEA_URL",
      "GITEA_BOT_TOKEN",
      "GITEA_WEBHOOK_SECRET",
      "JUMI_ROLE",
      "DATABASE_URL",
    ]);
    expect(parsed.reviewer.gitOpsEnv).toEqual([
      "FORGE_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_ALLOWED_ORGS",
      "GITHUB_WEBHOOK_SECRET",
    ]);
    expect(parsed.reviewer.optionalEnv).toEqual([
      "HOST",
      "PORT",
      "FORGE",
      "GITEA_WEBHOOK_AUTH_TOKEN",
      "GITEA_ALLOWED_ORGS",
      "GITEA_ALLOWED_REPOS",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_ALLOWED_REPOS",
      "JUMI_SECRETS_FILE",
      "BOT_USERNAME",
      "FOLLOWUP_IGNORE_LOGINS",
      "OPENCODE_MODEL",
      "OPENCODE_VARIANT",
      "OPENCODE_FALLBACK_MODEL",
      "OPENCODE_FALLBACK_VARIANT",
      "JUMI_RUNNERS_FILE",
      "OPENCODE_CONFIG",
      "OPENCODE_WELLKNOWN_URL",
      "OPENCODE_WELLKNOWN_KEY",
      "OPENCODE_WELLKNOWN_TOKEN",
      "HOME",
      "WORKDIR",
      "QUEUE_CONCURRENCY",
      "MAX_FILES",
      "MAX_PATCH_BYTES",
      "MAX_OUTPUT_BYTES",
      "MAX_WEBHOOK_BYTES",
      "OPENCODE_TIMEOUT_MS",
      "LEASE_MS",
      "MAX_JOB_ATTEMPTS",
      "MAX_FOLLOWUP_ROUNDS",
      "MAX_INCOMPLETE_RETRIES",
      "PHOENIX_OTLP_ENDPOINT",
      "BOARD_PEER_URL",
      "BOARD_PEER_TOKEN",
    ]);
    expect(parsed.worker.requiredEnv).toEqual(["GITEA_URL", "GITEA_BOT_TOKEN", "GITEA_WEBHOOK_SECRET"]);
    expect(parsed.worker.gitOpsEnv).toEqual([
      "DATABASE_URL",
      "FORGE_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_ALLOWED_ORGS",
      "GITHUB_WEBHOOK_SECRET",
    ]);
    expect(parsed.worker.optionalEnv).toEqual([
      "HOST",
      "PORT",
      "FORGE",
      "GITEA_WEBHOOK_AUTH_TOKEN",
      "GITEA_ALLOWED_ORGS",
      "GITEA_ALLOWED_REPOS",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_ALLOWED_REPOS",
      "JUMI_SECRETS_FILE",
      "BOT_USERNAME",
      "FOLLOWUP_IGNORE_LOGINS",
      "OPENCODE_MODEL",
      "OPENCODE_VARIANT",
      "OPENCODE_FALLBACK_MODEL",
      "OPENCODE_FALLBACK_VARIANT",
      "JUMI_RUNNERS_FILE",
      "OPENCODE_CONFIG",
      "OPENCODE_WELLKNOWN_URL",
      "OPENCODE_WELLKNOWN_KEY",
      "OPENCODE_WELLKNOWN_TOKEN",
      "HOME",
      "WORKDIR",
      "QUEUE_CONCURRENCY",
      "MAX_OUTPUT_BYTES",
      "MAX_WEBHOOK_BYTES",
      "OPENCODE_TIMEOUT_MS",
      "FOLLOWUP_TIMEOUT_MS",
      "CONFLICT_TIMEOUT_MS",
      "MAX_FOLLOWUP_ROUNDS",
      "MAX_CONFLICT_ROUNDS",
      "LEASE_MS",
      "MAX_JOB_ATTEMPTS",
      "PHOENIX_OTLP_ENDPOINT",
    ]);
    expect(parsed.reviewer.ports).toEqual(["3000", "3001"]);
    expect(parsed.worker.ports).toEqual(["3000"]);
    expect(parsed.reviewer.runAs).toBe("10001:10001");
    expect(parsed.worker.runAs).toBe("10001:10001");
    expect(parsed.reviewer.probes).toEqual(["GET /healthz port 3000"]);
    expect(parsed.worker.probes).toEqual(["GET /healthz port 3000"]);
    expect(parsed.reviewer.command).toBe("bun run src/server.ts");
    expect(parsed.worker.command).toBe("bun run src/worker_server.ts");
    expect(parsed.reviewer.imageTarget).toBe("runtime");
    expect(parsed.worker.imageTarget).toBe("worker");
    expect(parsed.reviewer.volumes).toEqual(["/data", "/work"]);
    expect(parsed.worker.volumes).toEqual(["/data", "/work"]);
    expect(parsed.reviewer.requiredConstraints).toEqual([ANTIGRAVITY_HOMELAB_CONSTRAINT]);
    expect(parsed.worker.requiredConstraints).toEqual([ANTIGRAVITY_HOMELAB_CONSTRAINT]);
    expect(markdown).toContain("workflow_job");
  });

  test("loader env matches contract required, gitops, and optional headings", async () => {
    const markdown = await readFile(join(repoRoot, "deploy/contract.md"), "utf8");
    const parsed = parseContract(markdown);
    const reviewerSrc = await readFile(join(repoRoot, "scripts/opencode/src/config.ts"), "utf8");
    const workerSrc = await readFile(join(repoRoot, "scripts/opencode/src/worker_config.ts"), "utf8");
    const reviewer = gitOpsLoaderEnv(reviewerSrc);
    const worker = gitOpsLoaderEnv(workerSrc, reviewerSrc);
    expect([...parsed.reviewer.requiredEnv].sort()).toEqual(reviewer.required);
    expect([...parsed.reviewer.gitOpsEnv, ...parsed.reviewer.optionalEnv].sort()).toEqual(
      [...reviewer.gitOps, ...reviewer.optional].sort()
    );
    expect([...parsed.worker.requiredEnv].sort()).toEqual(worker.required);
    expect([...parsed.worker.gitOpsEnv, ...parsed.worker.optionalEnv].sort()).toEqual(
      [...worker.gitOps, ...worker.optional].sort()
    );
    expect(contractEnvIssues(parsed, reviewerSrc, workerSrc)).toEqual([]);
    // Every name the real loaders require resolves, so nothing is skipped by the scanner.
    expect(reviewer.unresolved).toEqual([]);
    expect(worker.unresolved).toEqual([]);
    expect(reviewer.required).toContain("DATABASE_URL");
    expect(worker.optional).toContain("DATABASE_URL");
    expect(worker.required).not.toContain("DATABASE_URL");
  });

  test("FORGE=github keys are forge-conditional gitops env on both images", async () => {
    const markdown = await readFile(join(repoRoot, "deploy/contract.md"), "utf8");
    const parsed = parseContract(markdown);
    const reviewerSrc = await readFile(join(repoRoot, "scripts/opencode/src/config.ts"), "utf8");
    const workerSrc = await readFile(join(repoRoot, "scripts/opencode/src/worker_config.ts"), "utf8");
    const githubKeys = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "FORGE_URL", "GITHUB_ALLOWED_ORGS"];
    const reviewer = gitOpsLoaderEnv(reviewerSrc);
    const worker = gitOpsLoaderEnv(workerSrc, reviewerSrc);
    for (const key of [...githubKeys, "GITHUB_WEBHOOK_SECRET"]) {
      // The worker reaches them through the reviewer loader's shared loadForgeBind.
      expect(reviewer.gitOps).toContain(key);
      expect(worker.gitOps).toContain(key);
      expect(parsed.reviewer.gitOpsEnv).toContain(key);
      expect(parsed.worker.gitOpsEnv).toContain(key);
      expect(reviewer.required).not.toContain(key);
      expect(worker.required).not.toContain(key);
    }
    // Siblings the loader tolerates unset under either forge stay optional.
    expect(reviewer.optional).toContain("GITHUB_APP_INSTALLATION_ID");
    expect(reviewer.optional).toContain("GITHUB_ALLOWED_REPOS");
    expect(worker.optional).toContain("GITHUB_APP_INSTALLATION_ID");

    // Dropping one from the contract fails the gate on both images.
    for (const key of githubKeys) {
      const dropped = parseContract(markdown.replaceAll(`- \`${key}\`\n`, ""));
      expect(contractEnvIssues(dropped, reviewerSrc, workerSrc)).toEqual([
        { image: "reviewer", name: key, kind: "missing" },
        { image: "worker", name: key, kind: "missing" },
      ]);
    }

    // Adding them to gitops env is a required-GitOps change: major.
    const withoutGithub = markdown
      .split("\n")
      .filter((line) => !githubKeys.some((key) => line === `- \`${key}\``))
      .join("\n");
    expect(classifyBump(withoutGithub, markdown)).toBe("major");
  });

  test("the gate sees env names behind a constant map and rejects the wrong heading", () => {
    const reviewerSrc = `const GITHUB_ENV = {
  appId: "GITHUB_APP_ID",
  url: "FORGE_URL",
} as const;
const JUMI_ROLE_ENV = "JUMI_ROLE";
export function loadForgeBind(env: Env, opts: { requireWebhookSecret: boolean }): ForgeBind {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    requireEnv(env, GITHUB_ENV.appId);
    requireEnv(env, GITHUB_ENV.url);
    return { forge };
  }
  return { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
requireEnv(resolved, JUMI_ROLE_ENV);
`;
    const workerSrc = `loadForgeBind(resolved, { requireWebhookSecret: true });
`;
    const reviewer = gitOpsLoaderEnv(reviewerSrc);
    expect(reviewer.required).toEqual(["GITEA_URL", "JUMI_ROLE"]);
    expect(reviewer.gitOps).toEqual(["FORGE_URL", "GITHUB_APP_ID"]);
    expect(reviewer.optional).toEqual(["FORGE"]);
    // The worker delegates to the shared bind, so it inherits the same forge env.
    expect(gitOpsLoaderEnv(workerSrc, reviewerSrc)).toEqual({
      required: ["GITEA_URL"],
      gitOps: ["FORGE_URL", "GITHUB_APP_ID"],
      optional: ["FORGE"],
      unresolved: [],
    });

    const wrongHeadings = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`
- \`JUMI_ROLE\`
- \`GITHUB_APP_ID\`

#### optional env
- \`FORGE\`
- \`FORGE_URL\`

### worker

#### required env
- \`GITEA_URL\`

#### gitops env
- \`FORGE_URL\`
- \`GITHUB_APP_ID\`

#### optional env
- \`FORGE\`
`);
    expect(contractEnvIssues(wrongHeadings, reviewerSrc, workerSrc)).toEqual([
      { image: "reviewer", name: "FORGE_URL", kind: "forge_conditional_as_optional" },
      { image: "reviewer", name: "GITHUB_APP_ID", kind: "forge_conditional_as_required" },
    ]);
    expect(formatContractEnvIssue({ image: "worker", name: "GITHUB_APP_ID", kind: "missing" })).toContain(
      "missing from deploy/contract.md"
    );
  });

  test("a required env name the scanner cannot resolve fails the check instead of vanishing", () => {
    const reviewerSrc = `const KEYS = { appId: "GITHUB_APP_ID" } as const;
function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}
function requirePem(env: Env, name: string): string {
  return requireEnv(env, name);
}
export function loadForgeBind(env: Env, opts: { kind: "appId" }): ForgeBind {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    requireEnv(env, KEYS[opts.kind]);
    requirePem(env, pick("GITHUB_APP_PRIVATE_KEY"));
  }
  return { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
`;
    const workerSrc = `loadForgeBind(resolved, { requireWebhookSecret: true });
`;
    const reviewer = gitOpsLoaderEnv(reviewerSrc);
    // The helper declarations forward their own `name`; only the loader's own calls are env reads.
    expect(reviewer.required).toEqual(["GITEA_URL"]);
    expect(reviewer.gitOps).toEqual([]);
    expect(reviewer.unresolved).toEqual(["KEYS[opts.kind]", 'pick("GITHUB_APP_PRIVATE_KEY")']);
    const contract = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`

#### optional env
- \`FORGE\`

### worker

#### required env
- \`GITEA_URL\`

#### optional env
- \`FORGE\`
`);
    // Under-reporting would leave this empty and let an undocumented required env ship as a patch.
    expect(contractEnvIssues(contract, reviewerSrc, workerSrc)).toEqual([
      { image: "reviewer", name: "KEYS[opts.kind]", kind: "unresolved_env_ref" },
      { image: "reviewer", name: 'pick("GITHUB_APP_PRIVATE_KEY")', kind: "unresolved_env_ref" },
      { image: "worker", name: "KEYS[opts.kind]", kind: "unresolved_env_ref" },
      { image: "worker", name: 'pick("GITHUB_APP_PRIVATE_KEY")', kind: "unresolved_env_ref" },
    ]);
    expect(
      formatContractEnvIssue({ image: "reviewer", name: "KEYS[opts.kind]", kind: "unresolved_env_ref" })
    ).toContain("neither a string literal nor a constant");
  });

  test("a helper whose env argument is not a bare identifier still records the read", () => {
    const reviewerSrc = `export function loadConfig(env: Env): Config {
  const newKey = requireEnv(overlaySecretsFromFile(env), "BRAND_NEW_REQUIRED");
  return { url: requireEnv(ctx.env, "NEW_REQUIRED_KEY") };
}
`;
    const workerSrc = `export function loadWorkerConfig(env: Env): WorkerConfig {
  return { url: requireEnv(ctx.env, "NEW_REQUIRED_KEY") };
}
`;
    expect(gitOpsLoaderEnv(reviewerSrc)).toEqual({
      required: ["BRAND_NEW_REQUIRED", "NEW_REQUIRED_KEY"],
      gitOps: [],
      optional: [],
      unresolved: [],
    });
    expect(gitOpsLoaderEnv(workerSrc, reviewerSrc).required).toEqual(["NEW_REQUIRED_KEY"]);
    const contract = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env

### worker

#### required env
`);
    expect(contractEnvIssues(contract, reviewerSrc, workerSrc)).toEqual([
      { image: "reviewer", name: "BRAND_NEW_REQUIRED", kind: "missing" },
      { image: "reviewer", name: "NEW_REQUIRED_KEY", kind: "missing" },
      { image: "worker", name: "NEW_REQUIRED_KEY", kind: "missing" },
    ]);
  });

  test("comments and string bodies are not env reads", () => {
    const reviewerSrc = `/** Throws when env[name] is unset. */
function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}
export function loadConfig(env: Env): Config {
  // env.LEGACY_TOKEN was the old name
  const hint = "call requireEnv(env, NAME) instead";
  return { url: requireEnv(env, "GITEA_URL") };
}
`;
    expect(gitOpsLoaderEnv(reviewerSrc)).toEqual({
      required: ["GITEA_URL"],
      gitOps: [],
      optional: [],
      unresolved: [],
    });
  });

  test("a computed name is reported whatever helper reads it, while a const list resolves", () => {
    // gitops env reaches the loader through non-throwing reads too, so hiding one behind a
    // computed key must not be a way to add a major-bump variable while the gate stays green.
    const reviewerSrc = `const SECRETS = ["GITEA_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"] as const;
export function loadForgeBind(env: Env, opts: { k: string }): ForgeBind {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    optionalEnv(env, LOOKUP[opts.k]);
  }
  for (const key of SECRETS) {
    delete env[key];
  }
  return { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
`;
    const workerSrc = 'loadForgeBind(resolved, { k: "appId" });\n';
    const reviewer = gitOpsLoaderEnv(reviewerSrc);
    expect(reviewer.unresolved).toEqual(["LOOKUP[opts.k]"]);
    // `for (const key of SECRETS)` binds every entry of the list, so `env[key]` names them all.
    expect(reviewer.optional).toEqual(["FORGE", "GITEA_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"]);
    expect(gitOpsLoaderEnv(workerSrc, reviewerSrc).unresolved).toEqual(["LOOKUP[opts.k]"]);
  });

  test("a for-of binding is scoped to its own loop body", () => {
    const reviewerSrc = `const SECRETS = ["GITEA_BOT_TOKEN"] as const;
const OTHER = ["GITEA_URL"] as const;
for (const key of SECRETS) { delete env[key]; }
for (const key of extra) { requireEnv(env, key); }
for (const key of OTHER) { requireEnv(env, key); }
`;
    expect(gitOpsLoaderEnv(reviewerSrc)).toEqual({
      required: ["GITEA_URL"],
      gitOps: [],
      optional: ["GITEA_BOT_TOKEN"],
      unresolved: ["key"],
    });
  });

  test("an inline return-type annotation does not truncate the shared forge bind", () => {
    // `masked.indexOf("{")` after the parameter list would take the annotation's brace as the
    // body, leaving `withSharedForgeBind` to append a signature with no env reads at all.
    const reviewerSrc = `export function loadForgeBind(env: Env): { forge: string; giteaUrl: string } {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    return { forge, giteaUrl: requireEnv(env, "GITHUB_APP_ID") };
  }
  return { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
`;
    const workerSrc = "loadForgeBind(resolved, { requireWebhookSecret: true });\n";
    const inherited = { required: ["GITEA_URL"], gitOps: ["GITHUB_APP_ID"], optional: ["FORGE"], unresolved: [] };
    expect(gitOpsLoaderEnv(reviewerSrc)).toEqual(inherited);
    expect(gitOpsLoaderEnv(workerSrc, reviewerSrc)).toEqual(inherited);
    // A generic wrapping an object type ends at the same body brace.
    const promiseSrc = reviewerSrc.replace(": { forge: string; giteaUrl: string }", ": Promise<{ forge: string }>");
    expect(gitOpsLoaderEnv(promiseSrc)).toEqual(inherited);
  });

  test("a ternary forge guard is forge-conditional, and braces or colons in text do not end a branch", () => {
    const ternarySrc = `export function loadForgeBind(env: Env): ForgeBind {
  const forge = parseForge(env.FORGE);
  return forge === "github"
    ? {
        forge,
        // a colon and a brace in text must not close the branch: "} :"
        label: "github: }",
        appId: requireEnv(env, "GITHUB_APP_ID"),
        giteaUrl: requireEnv(env, "FORGE_URL"),
      }
    : { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
`;
    expect(gitOpsLoaderEnv(ternarySrc)).toEqual({
      required: ["GITEA_URL"],
      gitOps: ["FORGE_URL", "GITHUB_APP_ID"],
      optional: ["FORGE"],
      unresolved: [],
    });

    const bracedSrc = `export function loadForgeBind(env: Env): ForgeBind {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    const closing = "}";
    return { forge, closing, appId: requireEnv(env, "GITHUB_APP_ID") };
  }
  return { forge, giteaUrl: requireEnv(env, "GITEA_URL") };
}
`;
    expect(gitOpsLoaderEnv(bracedSrc)).toEqual({
      required: ["GITEA_URL"],
      gitOps: ["GITHUB_APP_ID"],
      optional: ["FORGE"],
      unresolved: [],
    });
  });

  test("CI fails when a loader env is missing or in the wrong heading", () => {
    const reviewerSrc = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "HOST");
intEnv(resolved, "PORT", 3000);
`;
    const workerSrc = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "DATABASE_URL");
intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3);
`;
    const contract = parseContract(BASE_CONTRACT);
    expect(contractEnvIssues(contract, reviewerSrc, workerSrc)).toEqual([
      { image: "reviewer", name: "HOST", kind: "missing" },
      { image: "reviewer", name: "PORT", kind: "missing" },
      { image: "reviewer", name: "GITEA_BOT_TOKEN", kind: "extra" },
      { image: "reviewer", name: "GITEA_WEBHOOK_SECRET", kind: "extra" },
      { image: "worker", name: "DATABASE_URL", kind: "missing" },
      { image: "worker", name: "MAX_FOLLOWUP_ROUNDS", kind: "missing" },
      { image: "worker", name: "GITEA_BOT_TOKEN", kind: "extra" },
      { image: "worker", name: "GITEA_WEBHOOK_SECRET", kind: "extra" },
    ]);
    const swapped = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env
- \`HOST\`

#### optional env
- \`GITEA_URL\`

### worker

#### required env
- \`GITEA_URL\`

#### optional env
- \`GITEA_URL\`
`);
    const matchingReviewer = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "HOST");
`;
    const matchingWorker = `requireEnv(resolved, "GITEA_URL");
`;
    expect(contractEnvIssues(swapped, matchingReviewer, matchingWorker)).toEqual([
      { image: "reviewer", name: "GITEA_URL", kind: "required_as_optional" },
      { image: "reviewer", name: "HOST", kind: "optional_as_required" },
      { image: "worker", name: "GITEA_URL", kind: "duplicate" },
    ]);
    const databaseDrift = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`

#### optional env
- \`DATABASE_URL\`

### worker

#### required env
- \`GITEA_URL\`
- \`DATABASE_URL\`

#### gitops env
- \`GITEA_URL\`
`);
    const reviewerWithDb = `${matchingReviewer.replace('optionalEnv(resolved, "HOST");\n', "")}requireEnv(resolved, "DATABASE_URL");
`;
    const workerWithDb = `${matchingWorker}optionalEnv(resolved, "DATABASE_URL");
`;
    expect(contractEnvIssues(databaseDrift, reviewerWithDb, workerWithDb)).toEqual([
      { image: "reviewer", name: "DATABASE_URL", kind: "required_as_optional" },
      { image: "worker", name: "GITEA_URL", kind: "duplicate" },
      { image: "worker", name: "DATABASE_URL", kind: "optional_as_required" },
    ]);
  });
});

describe("computeRelease git adapter", () => {
  test("no tag is v1.0.0 with GitOps none; unchanged contract patches; HEAD tag is reused", async () => {
    await withRepo(
      async (dir) => {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy/contract.md"), BASE_CONTRACT);
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "baseline"], dir);
      },
      async (dir) => {
        const first = computeRelease(dir);
        expect(first.version).toBe("v1.0.0");
        expect(first.bump).toBe("initial");
        expect(first.body).toContain("## GitOps\nnone\n");

        git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], dir);
        const reused = computeRelease(dir);
        expect(reused.version).toBe("v1.0.0");
        expect(reused.bump).toBe("reuse");

        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src/app.ts"), "export {}\n");
        git(["add", "src/app.ts"], dir);
        git(["commit", "-m", "code only"], dir);
        const patch = computeRelease(dir);
        expect(patch.version).toBe("v1.0.1");
        expect(patch.bump).toBe("patch");
        expect(patch.body).toContain("## GitOps\nnone\n");

        await writeFile(
          join(dir, "deploy/contract.md"),
          addListItem(BASE_CONTRACT, "worker", "gitops env", "DATABASE_URL")
        );
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "require worker DATABASE_URL"], dir);
        const major = computeRelease(dir);
        expect(major.version).toBe("v2.0.0");
        expect(major.bump).toBe("major");
        expect(major.body).toContain("### worker\n- **requires** `DATABASE_URL` (new; GitOps must set;");
        expect(major.body).toContain("## Breaking\nnone\n");
        expect(major.body).not.toMatch(/^## GitOps\nnone\n/m);
      }
    );
  });

  test("workflow-only HEAD does not advertise a version publish-github will not mint", async () => {
    await withRepo(
      async (dir) => {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy/contract.md"), BASE_CONTRACT);
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "baseline"], dir);
        git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], dir);
        await mkdir(join(dir, ".github/workflows"), { recursive: true });
        await writeFile(join(dir, ".github/workflows/ci.yml"), "name: ci\non: push\n");
        git(["add", ".github/workflows/ci.yml"], dir);
        git(["commit", "-m", "workflow only"], dir);
      },
      async (dir) => {
        const plan = computeRelease(dir);
        expect(plan.version).toBe("v1.0.1");
        expect(plan.bump).toBe("patch");
        expect(touchesGitHubWorkflows(dir)).toBe(true);
        expect(advertisedNextVersion(dir)).toBeNull();
      }
    );
  });

  test("untagged code HEAD still advertises the version that will be minted", async () => {
    await withRepo(
      async (dir) => {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy/contract.md"), BASE_CONTRACT);
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "baseline"], dir);
        git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], dir);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src/app.ts"), "export {}\n");
        git(["add", "src/app.ts"], dir);
        git(["commit", "-m", "code only"], dir);
      },
      async (dir) => {
        expect(touchesGitHubWorkflows(dir)).toBe(false);
        expect(advertisedNextVersion(dir)).toBe("v1.0.1");
      }
    );
  });
});

describe("image labels and no double-build", () => {
  test("Dockerfile and build scripts pass OCI source/version/revision", async () => {
    const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
    const reviewer = await readFile(join(repoRoot, ".gitea/scripts/build-reviewer-image.sh"), "utf8");
    const worker = await readFile(join(repoRoot, ".gitea/scripts/build-worker-image.sh"), "utf8");
    expect(dockerfile).toContain('org.opencontainers.image.source="https://gitea.kirmanak.stream/personal/jumi"');
    expect(dockerfile).toContain("org.opencontainers.image.version=");
    expect(dockerfile).toContain("org.opencontainers.image.revision=");
    expect(dockerfile).toContain("ARG VERSION=");
    expect(dockerfile).toContain("ARG REVISION=");
    expect(reviewer).toContain('--build-arg "VERSION=$' + '{VERSION}"');
    expect(reviewer).toContain('--build-arg "REVISION=$' + '{REVISION}"');
    expect(worker).toContain('--build-arg "VERSION=$' + '{VERSION}"');
    expect(worker).toContain('--build-arg "REVISION=$' + '{REVISION}"');
  });

  test("tag push does not start a second full image build", async () => {
    const reviewer = await readFile(join(repoRoot, ".github/workflows/jumi-reviewer-image.yml"), "utf8");
    const worker = await readFile(join(repoRoot, ".github/workflows/jumi-worker-image.yml"), "utf8");
    expect(workflowRebuildsOnTag(reviewer)).toBe(false);
    expect(workflowRebuildsOnTag(worker)).toBe(false);
    expect(shouldSkipImageBuild("tag")).toBe(true);
    expect(shouldSkipImageBuild("branch")).toBe(false);
    expect(reviewer).toContain("$" + "{IMAGE}:$" + "{VERSION}");
    expect(worker).toContain("$" + "{{ env.IMAGE }}:$" + "{{ env.VERSION }}");
    expect(reviewer).toContain("bun src/release.ts next-version");
    expect(worker).toContain("bun src/release.ts next-version");
    expect(reviewer).toContain("if: $" + "{{ env.VERSION != '' }}");
    expect(worker).toContain("if: $" + "{{ env.VERSION != '' }}");
    expect(worker).toContain("target: worker");
    expect(worker).toContain("ghcr.io/kirmanak/jumi-worker");
    expect(worker).toContain("branches: [main]");
    expect(worker).not.toContain("type=sha");
    expect(worker).not.toContain(":${{ github.sha");
    expect(reviewer).toContain("target: runtime");
    expect(reviewer).toContain("ghcr.io/kirmanak/jumi-reviewer");
    expect(reviewer).toContain("branches: [main]");
    expect(reviewer).not.toContain("type=sha");
    expect(reviewer).not.toContain(":${{ github.sha");
    const release = await readFile(join(repoRoot, ".github/workflows/jumi-release.yml"), "utf8");
    expect(release).toContain("bun src/release.ts publish-github");
    expect(release).not.toMatch(/bun src\/release\.ts publish\s*$/m);
    expect(release).toContain("github.token");
    expect(release).toContain("contents: write");
    expect(release).not.toContain("/api/v1");
    expect(release).not.toContain("GITEA_TOKEN");
    expect(release).not.toMatch(/^\s*tags:/m);
    expect(existsSync(join(repoRoot, ".gitea/workflows/jumi-release.yml"))).toBe(false);
  });
});

describe("publishRelease", () => {
  test("creates annotated tag and release; refuses to move tags; 403 explains no PAT", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/tags/v1.0.0") && method === "GET") return new Response("Not Found", { status: 404 });
      if (url.endsWith("/tags") && method === "POST") return new Response("{}", { status: 201 });
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") return new Response("Not Found", { status: 404 });
      if (url.endsWith("/releases") && method === "POST") return new Response("{}", { status: 201 });
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishRelease({
      serverUrl: "https://gitea.kirmanak.stream",
      token: "t",
      owner: "personal",
      repo: "jumi",
      sha: "abc",
      version: "v1.0.0",
      body: "## GitOps\nnone\n",
      fetchImpl,
    });
    expect(result).toEqual({ tagCreated: true, releaseCreated: true });
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/tags"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/releases"))).toBe(true);

    const moveFetch = async (input: string) => {
      if (String(input).endsWith("/tags/v1.0.0")) {
        return new Response(JSON.stringify({ commit: { sha: "old" } }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    };
    await expect(
      publishRelease({
        serverUrl: "https://gitea.kirmanak.stream",
        token: "t",
        owner: "personal",
        repo: "jumi",
        sha: "new",
        version: "v1.0.0",
        body: "x",
        fetchImpl: moveFetch,
      })
    ).rejects.toThrow("immutable tag");

    const forbidden = async () => new Response("nope", { status: 403 });
    await expect(
      publishRelease({
        serverUrl: "https://gitea.kirmanak.stream",
        token: "t",
        owner: "personal",
        repo: "jumi",
        sha: "abc",
        version: "v1.0.0",
        body: "x",
        fetchImpl: forbidden,
      })
    ).rejects.toThrow("Do not add a PAT");
  });
});

describe("publishGitHubRelease", () => {
  const baseOpts = {
    apiUrl: "https://api.github.com",
    token: "t",
    owner: "kirmanak",
    repo: "jumi",
    sha: "abc",
    version: "v1.0.0",
    body: "## GitOps\nnone\n",
  };

  test("peels annotated refs and omits target_commitish, generate_release_notes false, make_latest true", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/git/ref/tags/v1.0.0") && method === "GET") {
        return new Response(JSON.stringify({ object: { sha: "tagobj", type: "tag" } }), { status: 200 });
      }
      if (url.endsWith("/git/tags/tagobj") && method === "GET") {
        return new Response(JSON.stringify({ object: { sha: "abc", type: "commit" } }), { status: 200 });
      }
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/releases") && method === "POST") {
        return new Response("{}", { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishGitHubRelease({ ...baseOpts, fetchImpl });
    expect(result).toEqual({ tagCreated: false, releaseCreated: true });
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/releases"));
    expect(created?.body).toMatchObject({
      tag_name: "v1.0.0",
      generate_release_notes: false,
      make_latest: "true",
    });
    expect(created?.body).not.toHaveProperty("target_commitish");
  });

  test("creates tag object then ref when the tag is missing", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/git/ref/tags/v1.0.0") && method === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/git/tags") && method === "POST") {
        return new Response(JSON.stringify({ sha: "tagobj" }), { status: 201 });
      }
      if (url.endsWith("/git/refs") && method === "POST") {
        return new Response("{}", { status: 201 });
      }
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/releases") && method === "POST") {
        return new Response("{}", { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishGitHubRelease({ ...baseOpts, fetchImpl });
    expect(result).toEqual({ tagCreated: true, releaseCreated: true });
    const tagObj = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/tags"));
    const ref = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/refs"));
    expect(tagObj?.body).toMatchObject({ tag: "v1.0.0", object: "abc", type: "commit" });
    expect(ref?.body).toMatchObject({ ref: "refs/tags/v1.0.0", sha: "tagobj" });
    const tagIdx = calls.findIndex((call) => call.method === "POST" && call.url.endsWith("/git/tags"));
    const refIdx = calls.findIndex((call) => call.method === "POST" && call.url.endsWith("/git/refs"));
    expect(tagIdx).toBeGreaterThanOrEqual(0);
    expect(refIdx).toBeGreaterThan(tagIdx);
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/releases"));
    expect(created?.body).toMatchObject({
      tag_name: "v1.0.0",
      target_commitish: "abc",
      generate_release_notes: false,
      make_latest: "true",
    });
  });

  test("refuses to move an immutable tag", async () => {
    const fetchImpl = async (input: string) => {
      const url = String(input);
      if (url.endsWith("/git/ref/tags/v1.0.0")) {
        return new Response(JSON.stringify({ object: { sha: "tagobj", type: "tag" } }), { status: 200 });
      }
      if (url.endsWith("/git/tags/tagobj")) {
        return new Response(JSON.stringify({ object: { sha: "old", type: "commit" } }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    };
    await expect(publishGitHubRelease({ ...baseOpts, sha: "new", fetchImpl })).rejects.toThrow("immutable tag");
  });

  test("403 wording says do not add a PAT", async () => {
    const fetchImpl = async () => new Response("nope", { status: 403 });
    await expect(publishGitHubRelease({ ...baseOpts, fetchImpl })).rejects.toThrow("Do not add a PAT");
  });

  test("existing-tag backfill defaults make_latest true and POST /releases 404 fails the job", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/git/ref/tags/v1.0.0") && method === "GET") {
        return new Response(JSON.stringify({ object: { sha: "abc", type: "commit" } }), { status: 200 });
      }
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/releases") && method === "POST") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    };
    await expect(publishGitHubRelease({ ...baseOpts, fetchImpl })).rejects.toThrow("GitHub API POST /releases → 404");
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/releases"));
    expect(created?.body).toMatchObject({
      generate_release_notes: false,
      make_latest: "true",
    });
    expect(created?.body).not.toHaveProperty("target_commitish");
  });

  test("makeLatest false is posted only when a newer version was published", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/git/ref/tags/v1.0.0") && method === "GET") {
        return new Response(JSON.stringify({ object: { sha: "abc", type: "commit" } }), { status: 200 });
      }
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/releases") && method === "POST") {
        return new Response("{}", { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishGitHubRelease({
      ...baseOpts,
      makeLatest: false,
      fetchImpl,
    });
    expect(result).toEqual({ tagCreated: false, releaseCreated: true });
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/releases"));
    expect(created?.body).toMatchObject({
      generate_release_notes: false,
      make_latest: "false",
    });
    expect(created?.body).not.toHaveProperty("target_commitish");
  });

  test("workflow-only HEAD backfills existing latest without target_commitish and does not mint", async () => {
    await withRepo(
      async (dir) => {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy/contract.md"), BASE_CONTRACT);
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "baseline"], dir);
        git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], dir);
        await mkdir(join(dir, ".github/workflows"), { recursive: true });
        await writeFile(join(dir, ".github/workflows/ci.yml"), "name: ci\non: push\n");
        git(["add", ".github/workflows/ci.yml"], dir);
        git(["commit", "-m", "workflow only"], dir);
      },
      async (dir) => {
        const tagSha = peeledCommitForTag(dir, "v1.0.0");
        const headSha = peeledCommitForTag(dir, "HEAD");
        expect(tagSha).toBeTruthy();
        expect(headSha).toBeTruthy();
        const calls: { method: string; url: string; body?: unknown }[] = [];
        const fetchImpl = async (input: string, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          calls.push({ method, url, body });
          if (url.endsWith("/git/ref/tags/v1.0.0") && method === "GET") {
            return new Response(JSON.stringify({ object: { sha: tagSha, type: "commit" } }), { status: 200 });
          }
          if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") {
            return new Response("Not Found", { status: 404 });
          }
          if (url.endsWith("/releases") && method === "POST") {
            return new Response("Not Found", { status: 404 });
          }
          return new Response("unexpected", { status: 500 });
        };
        await expect(
          runPublishGitHub({
            repoDir: dir,
            apiUrl: "https://api.github.com",
            token: "t",
            owner: "kirmanak",
            repo: "jumi",
            sha: headSha!,
            fetchImpl,
          })
        ).rejects.toThrow("GitHub API POST /releases → 404");
        expect(calls.some((call) => call.url.includes("v1.0.1"))).toBe(false);
        const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/releases"));
        expect(created?.body).toMatchObject({
          tag_name: "v1.0.0",
          generate_release_notes: false,
          make_latest: "true",
        });
        expect(created?.body).not.toHaveProperty("target_commitish");
      }
    );
  });
});

describe("parseSemVerTag", () => {
  test("accepts vX.Y.Z only", () => {
    expect(parseSemVerTag("v1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseSemVerTag("v1.0.0-rc.1")).toBeNull();
    expect(parseSemVerTag("1.0.0")).toBeNull();
  });
});
