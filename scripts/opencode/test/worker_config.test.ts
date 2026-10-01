import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewQueue } from "../src/queue.ts";
import { AntigravityRefusedError, RUNNERS_FILE_ENV } from "../src/runners.ts";
import type { IssueJob } from "../src/types.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";
import { makeIssueJob } from "./fixtures.ts";

describe("loadWorkerConfig", () => {
  const required = {
    GITEA_URL: "https://gitea.kirmanak.stream/",
    GITEA_BOT_TOKEN: "bot-token",
    GITEA_WEBHOOK_SECRET: "secret",
  };

  test("does not require DATABASE_URL or JUMI_ROLE", () => {
    const config = loadWorkerConfig({
      ...required,
      JUMI_ROLE: "router",
    });
    expect(config.forge).toBe("gitea");
    expect(config.giteaUrl).toBe("https://gitea.kirmanak.stream");
    expect(config.databaseUrl).toBeUndefined();
    expect(config).not.toHaveProperty("role");
    expect(config.phoenixOtlpEndpoint).toBeUndefined();
    expect(config.opencodeWellKnownUrl).toBe("https://kirmanak.stream");
    expect(config.variant).toBeUndefined();
  });

  test("OPENCODE_WELLKNOWN_URL empty defaults, disabled is off, garbage fails closed", () => {
    expect(loadWorkerConfig({ ...required, OPENCODE_WELLKNOWN_URL: "" }).opencodeWellKnownUrl).toBe(
      "https://kirmanak.stream"
    );
    expect(loadWorkerConfig({ ...required, OPENCODE_WELLKNOWN_URL: "disabled" }).opencodeWellKnownUrl).toBeUndefined();
    expect(
      loadWorkerConfig({ ...required, OPENCODE_WELLKNOWN_URL: "https://opencode.example/" }).opencodeWellKnownUrl
    ).toBe("https://opencode.example");
    expect(() => loadWorkerConfig({ ...required, OPENCODE_WELLKNOWN_URL: "not-a-url" })).toThrow(
      "Invalid OPENCODE_WELLKNOWN_URL"
    );
  });

  test("OPENCODE_VARIANT is omitted unless set", () => {
    expect(loadWorkerConfig(required).variant).toBeUndefined();
    expect(loadWorkerConfig({ ...required, OPENCODE_VARIANT: "" }).variant).toBeUndefined();
    expect(loadWorkerConfig({ ...required, OPENCODE_VARIANT: "xhigh" }).variant).toBe("xhigh");
  });

  test("OPENCODE_FALLBACK_MODEL and VARIANT are omitted unless set", () => {
    expect(loadWorkerConfig(required).fallbackModel).toBeUndefined();
    expect(loadWorkerConfig(required).fallbackVariant).toBeUndefined();
    expect(loadWorkerConfig({ ...required, OPENCODE_FALLBACK_MODEL: "" }).fallbackModel).toBeUndefined();
    expect(loadWorkerConfig({ ...required, OPENCODE_FALLBACK_VARIANT: "" }).fallbackVariant).toBeUndefined();
    expect(
      loadWorkerConfig({ ...required, OPENCODE_FALLBACK_MODEL: "anthropic/claude-sonnet-4-6" }).fallbackModel
    ).toBe("anthropic/claude-sonnet-4-6");
    expect(loadWorkerConfig({ ...required, OPENCODE_FALLBACK_VARIANT: "high" }).fallbackVariant).toBe("high");
  });

  test("synthesizes a 1-entry OpenCode chain from OPENCODE_MODEL when fallback is unset", () => {
    const config = loadWorkerConfig(required);
    expect(config.chain).toEqual(["primary"]);
    expect(config.runners).toEqual({ primary: { type: "opencode", model: "openai/gpt-5.5" } });
    expect(config.model).toBe("openai/gpt-5.5");
    expect(config.fallbackModel).toBeUndefined();
  });

  test("synthesizes a 2-entry OpenCode chain from OPENCODE_MODEL and FALLBACK_*", () => {
    const config = loadWorkerConfig({
      ...required,
      OPENCODE_MODEL: "provider-a/model-one",
      OPENCODE_VARIANT: "xhigh",
      OPENCODE_FALLBACK_MODEL: "provider-b/model-two",
      OPENCODE_FALLBACK_VARIANT: "high",
    });
    expect(config.chain).toEqual(["primary", "fallback"]);
    expect(config.runners).toEqual({
      primary: { type: "opencode", model: "provider-a/model-one", variant: "xhigh" },
      fallback: { type: "opencode", model: "provider-b/model-two", variant: "high" },
    });
    expect(config.model).toBe("provider-a/model-one");
    expect(config.fallbackModel).toBe("provider-b/model-two");
  });

  test("JUMI_RUNNERS_FILE named runners override OPENCODE_*", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-worker-runners-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: {
          first: { type: "opencode", model: "provider-a/one" },
          second: { type: "opencode", model: "provider-b/two" },
        },
        chain: ["first", "second"],
      })
    );
    const config = loadWorkerConfig({ ...required, [RUNNERS_FILE_ENV]: file });
    expect(config.chain).toEqual(["first", "second"]);
    expect(config.model).toBe("provider-a/one");
    expect(config.fallbackModel).toBe("provider-b/two");

    const claudeFile = join(dir, "claude.json");
    writeFileSync(
      claudeFile,
      JSON.stringify({
        runners: {
          spark: { type: "claude", model: "opus" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["spark", "grok"],
      })
    );
    const claudeConfig = loadWorkerConfig({ ...required, [RUNNERS_FILE_ENV]: claudeFile });
    expect(claudeConfig.chain).toEqual(["spark", "grok"]);
    expect(claudeConfig.runners.spark).toEqual({ type: "claude", model: "opus" });
  });

  test("Gitea worker refuses a runners file that names Antigravity", () => {
    expect(loadWorkerConfig(required).runners).toEqual({
      primary: { type: "opencode", model: "openai/gpt-5.5" },
    });
    const dir = mkdtempSync(join(tmpdir(), "jumi-worker-agy-gitea-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: { agy: { type: "agy", model: "gemini-3-pro" } },
        chain: ["agy"],
      })
    );
    for (const forge of [undefined, "", "gitea"] as const) {
      const env = forge === undefined ? required : { ...required, FORGE: forge };
      expect(() => loadWorkerConfig({ ...env, [RUNNERS_FILE_ENV]: file })).toThrow(AntigravityRefusedError);
    }
  });

  test("parses optional PHOENIX_OTLP_ENDPOINT", () => {
    const config = loadWorkerConfig({
      ...required,
      PHOENIX_OTLP_ENDPOINT: "http://phoenix.phoenix.svc:6006",
    });
    expect(config.phoenixOtlpEndpoint).toBe("http://phoenix.phoenix.svc:6006");
  });

  test("has no scan-interval env", () => {
    const config = loadWorkerConfig({ ...required, WORKER_SCAN_INTERVAL_MS: "60000" });
    expect(config).not.toHaveProperty("scanIntervalMs");
  });

  test("loads optional DATABASE_URL when set", () => {
    const config = loadWorkerConfig({
      ...required,
      DATABASE_URL: "postgres://jumi",
    });
    expect(config.databaseUrl).toBe("postgres://jumi");
  });

  test("follow-up and conflict caps fall back when env is unset or empty", () => {
    const unset = loadWorkerConfig(required);
    expect(unset.maxFollowupRounds).toBe(3);
    expect(unset.maxConflictRounds).toBe(3);
    expect(unset.followupTimeoutMs).toBe(3_600_000);
    expect(unset.conflictTimeoutMs).toBe(3_600_000);

    const empty = loadWorkerConfig({
      ...required,
      MAX_FOLLOWUP_ROUNDS: "",
      MAX_CONFLICT_ROUNDS: "",
      FOLLOWUP_TIMEOUT_MS: "",
      CONFLICT_TIMEOUT_MS: "",
    });
    expect(empty.maxFollowupRounds).toBe(3);
    expect(empty.maxConflictRounds).toBe(3);
    expect(empty.followupTimeoutMs).toBe(3_600_000);
    expect(empty.conflictTimeoutMs).toBe(3_600_000);
  });

  test("parses follow-up and conflict cap env", () => {
    const config = loadWorkerConfig({
      ...required,
      MAX_FOLLOWUP_ROUNDS: "5",
      MAX_CONFLICT_ROUNDS: "7",
      FOLLOWUP_TIMEOUT_MS: "1800000",
      CONFLICT_TIMEOUT_MS: "900000",
    });
    expect(config.maxFollowupRounds).toBe(5);
    expect(config.maxConflictRounds).toBe(7);
    expect(config.followupTimeoutMs).toBe(1_800_000);
    expect(config.conflictTimeoutMs).toBe(900_000);
  });

  test("follow-up and conflict timeouts do not inherit OPENCODE_TIMEOUT_MS", () => {
    const config = loadWorkerConfig({
      ...required,
      OPENCODE_TIMEOUT_MS: "14400000",
    });
    expect(config.opencodeTimeoutMs).toBe(14_400_000);
    expect(config.followupTimeoutMs).toBe(3_600_000);
    expect(config.conflictTimeoutMs).toBe(3_600_000);
  });

  test("rejects invalid follow-up and conflict cap env", () => {
    expect(() => loadWorkerConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, MAX_CONFLICT_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, FOLLOWUP_TIMEOUT_MS: "abc" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, CONFLICT_TIMEOUT_MS: "-1" })).toThrow("Invalid positive integer");
  });

  test("parses TRUSTED_SENDER_LOGINS CSV, trims each login, and treats empty as no list", () => {
    expect(loadWorkerConfig(required).trustedSenderLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, TRUSTED_SENDER_LOGINS: "" }).trustedSenderLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, TRUSTED_SENDER_LOGINS: " , " }).trustedSenderLogins).toEqual([]);
    expect(
      loadWorkerConfig({ ...required, TRUSTED_SENDER_LOGINS: " alice , filer[bot], " }).trustedSenderLogins
    ).toEqual(["alice", "filer[bot]"]);
  });

  test("parses FOLLOWUP_IGNORE_LOGINS CSV and treats empty as no extra skips", () => {
    expect(loadWorkerConfig(required).followupIgnoreLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "" }).followupIgnoreLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: " , " }).followupIgnoreLogins).toEqual([]);
    expect(
      loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "tapio, renovate-bot, " }).followupIgnoreLogins
    ).toEqual(["tapio", "renovate-bot"]);
  });

  const githubPem = "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----";
  const githubRequired = {
    FORGE: "github",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: githubPem,
    GITHUB_WEBHOOK_SECRET: "gh-secret",
    FORGE_URL: "https://github.com/",
    GITHUB_ALLOWED_ORGS: "acme",
  };

  test("FORGE unset or gitea still requires GITEA_URL / GITEA_BOT_TOKEN", () => {
    expect(loadWorkerConfig(required).forge).toBe("gitea");
    expect(loadWorkerConfig({ ...required, FORGE: "" }).forge).toBe("gitea");
    expect(loadWorkerConfig({ ...required, FORGE: "gitea" }).giteaToken).toBe("bot-token");
    expect(() => loadWorkerConfig({ ...required, FORGE: "gitea", GITEA_URL: "" })).toThrow("GITEA_URL");
    expect(() => loadWorkerConfig({ ...required, FORGE: "gitea", GITEA_BOT_TOKEN: "" })).toThrow("GITEA_BOT_TOKEN");
    expect(() => loadWorkerConfig({ ...required, FORGE: "gitlab" })).toThrow("Invalid FORGE");
  });

  test("FORGE=github without GitHub env fails closed", () => {
    expect(() => loadWorkerConfig({ ...required, FORGE: "github" })).toThrow("GITHUB_APP_ID");
    expect(() => loadWorkerConfig({ FORGE: "github" })).toThrow("GITHUB_APP_ID");
    expect(() => loadWorkerConfig({ ...githubRequired, GITHUB_WEBHOOK_SECRET: "" })).toThrow("GITHUB_WEBHOOK_SECRET");
    expect(() => loadWorkerConfig({ ...githubRequired, FORGE_URL: "" })).toThrow("FORGE_URL");
    expect(() => loadWorkerConfig({ ...githubRequired, GITHUB_ALLOWED_ORGS: "" })).toThrow("GITHUB_ALLOWED_ORGS");
  });

  test("FORGE=github still starts when the runners file names Antigravity", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-worker-agy-github-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: { agy: { type: "agy", model: "gemini-3-pro", effort: "high" } },
        chain: ["agy"],
      })
    );
    const config = loadWorkerConfig({ ...githubRequired, [RUNNERS_FILE_ENV]: file });
    expect(config.forge).toBe("github");
    expect(config.chain).toEqual(["agy"]);
    expect(config.runners.agy).toEqual({ type: "agy", model: "gemini-3-pro", effort: "high" });
  });

  test("FORGE=github dual-binds URL/orgs/webhook and optional repos", () => {
    const config = loadWorkerConfig({
      ...githubRequired,
      GITHUB_ALLOWED_REPOS: "acme/a",
    });
    expect(config.forge).toBe("github");
    expect(config.giteaUrl).toBe("https://github.com");
    expect(config.webhookSecret).toBe("gh-secret");
    expect(config.allowedOrgs).toEqual(["acme"]);
    expect(config.allowedRepos).toEqual(["acme/a"]);
    expect(config.githubAppId).toBe("123");
    expect(config.githubAppPrivateKey).toBe(githubPem);
    expect(config.githubAppInstallationId).toBeUndefined();
  });

  test("FORGE=github treats GITHUB_APP_INSTALLATION_ID as an optional hint", () => {
    expect(loadWorkerConfig(githubRequired).githubAppInstallationId).toBeUndefined();
    expect(loadWorkerConfig({ ...githubRequired, GITHUB_APP_INSTALLATION_ID: "456" }).githubAppInstallationId).toBe(
      "456"
    );
  });
});

describe("worker ReviewQueue", () => {
  test("still uses the in-memory queue without DATABASE_URL", async () => {
    const seen: number[] = [];
    const queue = new ReviewQueue<IssueJob>(
      async (job) => {
        seen.push(job.issueNumber);
      },
      1,
      () => undefined,
      (job) => `${job.owner}/${job.repo}#${job.issueNumber}`
    );
    queue.enqueue(makeIssueJob());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([12]);
  });
});
