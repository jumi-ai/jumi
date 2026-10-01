import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, SECRET_ENV_KEYS, SECRETS_FILE_ENV, scrubSecretEnv } from "../src/config.ts";
import { AntigravityRefusedError, RUNNERS_FILE_ENV } from "../src/runners.ts";
import { validateCloneUrl } from "../src/workspace.ts";

describe("loadConfig", () => {
  const required = {
    GITEA_URL: "https://gitea.kirmanak.stream/",
    GITEA_BOT_TOKEN: "bot-token",
    GITEA_WEBHOOK_SECRET: "secret",
    JUMI_ROLE: "router",
    DATABASE_URL: "postgres://jumi",
  };

  test("loads defaults and normalizes values", () => {
    const config = loadConfig(required);

    expect(config.forge).toBe("gitea");
    expect(config.giteaUrl).toBe("https://gitea.kirmanak.stream");
    expect(validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", config.giteaUrl)).toBe(
      "https://gitea.kirmanak.stream/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://github.com/kirmanak/jumi.git", config.giteaUrl)).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
    expect(config.allowedOrgs).toEqual(["kirmanak"]);
    expect(config.allowedRepos).toEqual([]);
    expect(config.botUsername).toBe("jumi");
    expect(config.model).toBe("openai/gpt-5.5");
    expect(config.variant).toBeUndefined();
    expect(config.opencodeWellKnownUrl).toBe("https://kirmanak.stream");
    expect(loadConfig({ ...required, OPENCODE_WELLKNOWN_URL: "" }).opencodeWellKnownUrl).toBe(
      "https://kirmanak.stream"
    );
    expect(loadConfig({ ...required, OPENCODE_WELLKNOWN_URL: "disabled" }).opencodeWellKnownUrl).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_WELLKNOWN_URL: "https://opencode.example/" }).opencodeWellKnownUrl).toBe(
      "https://opencode.example"
    );
    expect(() => loadConfig({ ...required, OPENCODE_WELLKNOWN_URL: "not-a-url" })).toThrow(
      "Invalid OPENCODE_WELLKNOWN_URL"
    );
    expect(config.opencodeWellKnownKey).toBe("OPENCODE_WELLKNOWN_TOKEN");
    expect(config.opencodeWellKnownToken).toBe("unused");
    expect(config.queueConcurrency).toBe(1);
    expect(config.role).toBe("router");
    expect(config.databaseUrl).toBe("postgres://jumi");
    expect(config.leaseMs).toBe(900_000 + 10 * 60 * 1000);
    expect(config.maxJobAttempts).toBe(2);
    expect(config.maxFollowupRounds).toBe(3);
    expect(config.maxIncompleteRetries).toBe(2);
    expect(config.phoenixOtlpEndpoint).toBeUndefined();
  });

  test("MAX_FOLLOWUP_ROUNDS unset or empty is 3; invalid fail-closed", () => {
    expect(loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "" }).maxFollowupRounds).toBe(3);
    expect(loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "5" }).maxFollowupRounds).toBe(5);
    expect(() => loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "abc" })).toThrow("Invalid positive integer");
  });

  test("MAX_INCOMPLETE_RETRIES unset or empty is 2; invalid fail-closed", () => {
    expect(loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "" }).maxIncompleteRetries).toBe(2);
    expect(loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "1" }).maxIncompleteRetries).toBe(1);
    expect(() => loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "abc" })).toThrow("Invalid positive integer");
  });

  test("OPENCODE_VARIANT is omitted unless set", () => {
    expect(loadConfig(required).variant).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_VARIANT: "" }).variant).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_VARIANT: "xhigh" }).variant).toBe("xhigh");
  });

  test("OPENCODE_FALLBACK_MODEL and VARIANT are omitted unless set", () => {
    expect(loadConfig(required).fallbackModel).toBeUndefined();
    expect(loadConfig(required).fallbackVariant).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_FALLBACK_MODEL: "" }).fallbackModel).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_FALLBACK_VARIANT: "" }).fallbackVariant).toBeUndefined();
    expect(loadConfig({ ...required, OPENCODE_FALLBACK_MODEL: "anthropic/claude-sonnet-4-6" }).fallbackModel).toBe(
      "anthropic/claude-sonnet-4-6"
    );
    expect(loadConfig({ ...required, OPENCODE_FALLBACK_VARIANT: "high" }).fallbackVariant).toBe("high");
  });

  test("synthesizes a 1-entry OpenCode chain from OPENCODE_MODEL when fallback is unset", () => {
    const config = loadConfig(required);
    expect(config.chain).toEqual(["primary"]);
    expect(config.runners).toEqual({ primary: { type: "opencode", model: "openai/gpt-5.5" } });
    expect(config.model).toBe("openai/gpt-5.5");
    expect(config.fallbackModel).toBeUndefined();
  });

  test("synthesizes a 2-entry OpenCode chain from OPENCODE_MODEL and FALLBACK_*", () => {
    const config = loadConfig({
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
    expect(config.variant).toBe("xhigh");
    expect(config.fallbackModel).toBe("provider-b/model-two");
    expect(config.fallbackVariant).toBe("high");
  });

  test("JUMI_RUNNERS_FILE named runners override OPENCODE_* and unknown type fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-runners-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: {
          first: { type: "opencode", model: "provider-a/one", variant: "xhigh" },
          second: { type: "opencode", model: "provider-b/two", variant: "high" },
        },
        chain: ["first", "second"],
      })
    );
    const config = loadConfig({
      ...required,
      OPENCODE_MODEL: "openai/gpt-5.5",
      OPENCODE_FALLBACK_MODEL: "ignored/fallback",
      [RUNNERS_FILE_ENV]: file,
    });
    expect(config.chain).toEqual(["first", "second"]);
    expect(config.model).toBe("provider-a/one");
    expect(config.variant).toBe("xhigh");
    expect(config.fallbackModel).toBe("provider-b/two");
    expect(config.fallbackVariant).toBe("high");
    expect(config.runners).toEqual({
      first: { type: "opencode", model: "provider-a/one", variant: "xhigh" },
      second: { type: "opencode", model: "provider-b/two", variant: "high" },
    });

    const claudeFile = join(dir, "claude.json");
    writeFileSync(
      claudeFile,
      JSON.stringify({
        runners: {
          spark: { type: "claude", model: "opus", effort: "high" },
          grok: { type: "opencode", model: "opencode/grok-4.6", variant: "high" },
        },
        chain: ["spark", "grok"],
      })
    );
    const claudeConfig = loadConfig({ ...required, [RUNNERS_FILE_ENV]: claudeFile });
    expect(claudeConfig.chain).toEqual(["spark", "grok"]);
    expect(claudeConfig.runners).toEqual({
      spark: { type: "claude", model: "opus", effort: "high" },
      grok: { type: "opencode", model: "opencode/grok-4.6", variant: "high" },
    });
    expect(claudeConfig.model).toBe("opus");
    expect(claudeConfig.variant).toBeUndefined();
    expect(claudeConfig.fallbackModel).toBe("opencode/grok-4.6");
    expect(claudeConfig.fallbackVariant).toBe("high");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ runners: { x: { type: "hermes", model: "claude" } }, chain: ["x"] }));
    expect(() => loadConfig({ ...required, [RUNNERS_FILE_ENV]: bad })).toThrow("Unknown runner type");
  });

  test("Gitea reviewer refuses a runners file that names Antigravity and still synthesizes OpenCode", () => {
    expect(loadConfig(required).runners).toEqual({
      primary: { type: "opencode", model: "openai/gpt-5.5" },
    });
    const dir = mkdtempSync(join(tmpdir(), "jumi-agy-gitea-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: {
          agy: { type: "agy", model: "gemini-3-pro", effort: "high" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["agy", "grok"],
      })
    );
    for (const forge of [undefined, "", "gitea"] as const) {
      const env = forge === undefined ? required : { ...required, FORGE: forge };
      expect(() => loadConfig({ ...env, [RUNNERS_FILE_ENV]: file, JUMI_ROLE: "router" })).toThrow(
        AntigravityRefusedError
      );
      expect(() => loadConfig({ ...env, [RUNNERS_FILE_ENV]: file, JUMI_ROLE: "engine" })).toThrow(
        AntigravityRefusedError
      );
    }
    const unused = join(dir, "unused.json");
    writeFileSync(
      unused,
      JSON.stringify({
        runners: {
          spare: { type: "agy", model: "gemini-3-pro" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["grok"],
      })
    );
    expect(() => loadConfig({ ...required, [RUNNERS_FILE_ENV]: unused })).toThrow(
      "Antigravity refused unless FORGE=github"
    );
  });

  test("parses optional PHOENIX_OTLP_ENDPOINT", () => {
    const config = loadConfig({
      ...required,
      PHOENIX_OTLP_ENDPOINT: "http://phoenix.phoenix.svc:6006",
    });
    expect(config.phoenixOtlpEndpoint).toBe("http://phoenix.phoenix.svc:6006");
  });

  test("requires DATABASE_URL for router and engine", () => {
    expect(() => loadConfig({ ...required, JUMI_ROLE: "router", DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "engine", DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(loadConfig({ ...required, JUMI_ROLE: "router" }).role).toBe("router");
    expect(loadConfig({ ...required, JUMI_ROLE: "engine" }).databaseUrl).toBe("postgres://jumi");
  });

  test("parses LEASE_MS and MAX_JOB_ATTEMPTS", () => {
    const config = loadConfig({
      ...required,
      JUMI_ROLE: "engine",
      DATABASE_URL: "postgres://jumi",
      LEASE_MS: "1000",
      MAX_JOB_ATTEMPTS: "3",
    });
    expect(config.leaseMs).toBe(1000);
    expect(config.maxJobAttempts).toBe(3);
  });

  test("rejects missing, empty, and unknown JUMI_ROLE", () => {
    expect(() => loadConfig({ ...required, JUMI_ROLE: undefined })).toThrow("JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "" })).toThrow("JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "worker" })).toThrow("Invalid JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "monolith" })).toThrow("Invalid JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "garbage" })).toThrow("Invalid JUMI_ROLE");
  });

  test("parses CSV and integer options", () => {
    const config = loadConfig({
      ...required,
      GITEA_ALLOWED_ORGS: "kirmanak,personal",
      GITEA_ALLOWED_REPOS: "kirmanak/a, kirmanak/b",
      QUEUE_CONCURRENCY: "2",
      MAX_FILES: "3",
    });

    expect(config.allowedOrgs).toEqual(["kirmanak", "personal"]);
    expect(config.allowedRepos).toEqual(["kirmanak/a", "kirmanak/b"]);
    expect(config.queueConcurrency).toBe(2);
    expect(config.maxFiles).toBe(3);
  });

  test("parses TRUSTED_SENDER_LOGINS CSV, trims each login, and treats empty as no list", () => {
    expect(loadConfig(required).trustedSenderLogins).toEqual([]);
    expect(loadConfig({ ...required, TRUSTED_SENDER_LOGINS: "" }).trustedSenderLogins).toEqual([]);
    expect(loadConfig({ ...required, TRUSTED_SENDER_LOGINS: " , " }).trustedSenderLogins).toEqual([]);
    expect(loadConfig({ ...required, TRUSTED_SENDER_LOGINS: " alice , filer[bot], " }).trustedSenderLogins).toEqual([
      "alice",
      "filer[bot]",
    ]);
  });

  test("parses FOLLOWUP_IGNORE_LOGINS CSV and treats empty as no extra skips", () => {
    expect(loadConfig(required).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "" }).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: " , " }).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "tapio, renovate-bot, " }).followupIgnoreLogins).toEqual([
      "tapio",
      "renovate-bot",
    ]);
  });

  test("parses wildcard owner allowlist", () => {
    const config = loadConfig({
      ...required,
      GITEA_ALLOWED_ORGS: "*",
    });

    expect(config.allowedOrgs).toEqual(["*"]);
  });

  test("requires secrets and rejects invalid positive integers", () => {
    expect(() =>
      loadConfig({
        GITEA_URL: "https://gitea.kirmanak.stream",
        GITEA_BOT_TOKEN: "token",
        JUMI_ROLE: "router",
        DATABASE_URL: "postgres://jumi",
      })
    ).toThrow("GITEA_WEBHOOK_SECRET");
    expect(() => loadConfig({ ...required, MAX_FILES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, PORT: "abc" })).toThrow("Invalid positive integer");
  });

  test("engine does not require GITEA_WEBHOOK_SECRET; router still does", () => {
    const config = loadConfig({
      JUMI_ROLE: "engine",
      DATABASE_URL: "postgres://jumi",
      GITEA_URL: "https://gitea.kirmanak.stream",
      GITEA_BOT_TOKEN: "token",
    });
    expect(config.role).toBe("engine");
    expect(config.webhookSecret).toBe("");
    expect(config.giteaToken).toBe("token");
    expect(() =>
      loadConfig({
        JUMI_ROLE: "router",
        DATABASE_URL: "postgres://jumi",
        GITEA_URL: "https://gitea.kirmanak.stream",
        GITEA_BOT_TOKEN: "token",
      })
    ).toThrow("GITEA_WEBHOOK_SECRET");
  });

  test("scrubSecretEnv unsets Gitea secrets after they have been copied into config", () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of SECRET_ENV_KEYS) {
      previous[key] = process.env[key];
    }
    process.env.GITEA_BOT_TOKEN = "live-bot-token";
    process.env.GITEA_WEBHOOK_SECRET = "live-webhook-secret";
    process.env.GITEA_WEBHOOK_AUTH_TOKEN = "live-auth-token";
    try {
      const config = loadConfig({
        ...required,
        GITEA_BOT_TOKEN: process.env.GITEA_BOT_TOKEN,
        GITEA_WEBHOOK_SECRET: process.env.GITEA_WEBHOOK_SECRET,
        GITEA_WEBHOOK_AUTH_TOKEN: process.env.GITEA_WEBHOOK_AUTH_TOKEN,
      });
      expect(config.giteaToken).toBe("live-bot-token");
      expect(config.webhookSecret).toBe("live-webhook-secret");
      expect(config.webhookAuthToken).toBe("live-auth-token");

      process.env.GITHUB_APP_PRIVATE_KEY = "live-github-pem";
      process.env.GITHUB_WEBHOOK_SECRET = "live-gh-webhook";
      scrubSecretEnv();
      expect(process.env.GITEA_BOT_TOKEN).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_SECRET).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_AUTH_TOKEN).toBeUndefined();
      expect(process.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      expect(process.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
      expect(config.giteaToken).toBe("live-bot-token");
    } finally {
      for (const key of SECRET_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("loadConfig reads Gitea secrets from JUMI_SECRETS_FILE and unlinks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-secrets-"));
    const file = join(dir, "secrets.json");
    writeFileSync(
      file,
      JSON.stringify({
        GITEA_BOT_TOKEN: "file-bot-token",
        GITEA_WEBHOOK_SECRET: "file-webhook-secret",
        GITEA_WEBHOOK_AUTH_TOKEN: "file-auth-token",
      }),
      { mode: 0o600 }
    );

    const config = loadConfig({
      GITEA_URL: "https://gitea.kirmanak.stream",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
      [SECRETS_FILE_ENV]: file,
    });

    expect(config.giteaToken).toBe("file-bot-token");
    expect(config.webhookSecret).toBe("file-webhook-secret");
    expect(config.webhookAuthToken).toBe("file-auth-token");
    expect(() => readFileSync(file)).toThrow();
  });

  const githubPem = "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----";
  const githubRequired = {
    FORGE: "github",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: githubPem,
    GITHUB_WEBHOOK_SECRET: "gh-secret",
    FORGE_URL: "https://github.com/",
    GITHUB_ALLOWED_ORGS: "acme",
    JUMI_ROLE: "router",
    DATABASE_URL: "postgres://jumi",
  };

  test("FORGE unset or empty or gitea keeps GITEA_* requirements", () => {
    expect(loadConfig(required).forge).toBe("gitea");
    expect(loadConfig({ ...required, FORGE: "" }).forge).toBe("gitea");
    expect(loadConfig({ ...required, FORGE: "gitea" }).forge).toBe("gitea");
    expect(() => loadConfig({ ...required, FORGE: "gitea", GITEA_URL: "" })).toThrow("GITEA_URL");
    expect(() => loadConfig({ ...required, FORGE: "gitea", GITEA_BOT_TOKEN: "" })).toThrow("GITEA_BOT_TOKEN");
  });

  test("invalid FORGE fails closed", () => {
    expect(() => loadConfig({ ...required, FORGE: "gitlab" })).toThrow("Invalid FORGE");
  });

  test("FORGE=github without GitHub env fails closed", () => {
    expect(() => loadConfig({ ...required, FORGE: "github" })).toThrow("GITHUB_APP_ID");
    expect(() => loadConfig({ FORGE: "github", JUMI_ROLE: "router", DATABASE_URL: "postgres://jumi" })).toThrow(
      "GITHUB_APP_ID"
    );
    expect(() => loadConfig({ ...githubRequired, GITHUB_APP_PRIVATE_KEY: "" })).toThrow("GITHUB_APP_PRIVATE_KEY");
    expect(() => loadConfig({ ...githubRequired, FORGE_URL: "" })).toThrow("FORGE_URL");
    expect(() => loadConfig({ ...githubRequired, GITHUB_ALLOWED_ORGS: "" })).toThrow("GITHUB_ALLOWED_ORGS");
  });

  test("FORGE=github still starts when the runners file names Antigravity", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-agy-github-"));
    const file = join(dir, "runners.json");
    writeFileSync(
      file,
      JSON.stringify({
        runners: { agy: { type: "agy", model: "gemini-3-pro", effort: "high" } },
        chain: ["agy"],
      })
    );
    const config = loadConfig({ ...githubRequired, [RUNNERS_FILE_ENV]: file });
    expect(config.forge).toBe("github");
    expect(config.chain).toEqual(["agy"]);
    expect(config.runners.agy).toEqual({ type: "agy", model: "gemini-3-pro", effort: "high" });
  });

  test("FORGE=github dual-binds URL/orgs/webhook and requires GitHub App env", () => {
    const config = loadConfig(githubRequired);
    expect(config.forge).toBe("github");
    expect(config.giteaUrl).toBe("https://github.com");
    expect(config.giteaToken).toBe("");
    expect(config.webhookSecret).toBe("gh-secret");
    expect(config.allowedOrgs).toEqual(["acme"]);
    expect(config.allowedRepos).toEqual([]);
    expect(config.githubAppId).toBe("123");
    expect(config.githubAppPrivateKey).toBe(githubPem);
    expect(config.githubAppInstallationId).toBeUndefined();
    expect(validateCloneUrl("https://github.com/kirmanak/jumi.git", config.giteaUrl)).toBe(
      "https://github.com/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", config.giteaUrl)).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
  });

  test("FORGE=github treats GITHUB_APP_INSTALLATION_ID as an optional hint", () => {
    expect(loadConfig(githubRequired).githubAppInstallationId).toBeUndefined();
    expect(loadConfig({ ...githubRequired, GITHUB_APP_INSTALLATION_ID: "" }).githubAppInstallationId).toBeUndefined();
    expect(loadConfig({ ...githubRequired, GITHUB_APP_INSTALLATION_ID: "456" }).githubAppInstallationId).toBe("456");
  });

  test("FORGE=github optional GITHUB_ALLOWED_REPOS and escaped PEM", () => {
    const config = loadConfig({
      ...githubRequired,
      GITHUB_ALLOWED_REPOS: "acme/a, acme/b",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
    });
    expect(config.allowedRepos).toEqual(["acme/a", "acme/b"]);
    expect(config.githubAppPrivateKey).toBe(githubPem);
  });

  test("FORGE=github engine does not require GITHUB_WEBHOOK_SECRET; router still does; invalid PEM fails", () => {
    const engine = loadConfig({ ...githubRequired, JUMI_ROLE: "engine", GITHUB_WEBHOOK_SECRET: "" });
    expect(engine.role).toBe("engine");
    expect(engine.webhookSecret).toBe("");
    expect(engine.githubAppId).toBe("123");
    expect(engine.githubAppPrivateKey).toBe(githubPem);
    expect(loadConfig({ ...githubRequired, JUMI_ROLE: "engine" }).webhookSecret).toBe("gh-secret");
    expect(() => loadConfig({ ...githubRequired, GITHUB_WEBHOOK_SECRET: "" })).toThrow("GITHUB_WEBHOOK_SECRET");
    expect(() => loadConfig({ ...githubRequired, GITHUB_APP_PRIVATE_KEY: "not-a-key" })).toThrow("Invalid PEM");
  });

  test("loadConfig reads GitHub secrets from JUMI_SECRETS_FILE and unlinks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-gh-secrets-"));
    const file = join(dir, "secrets.json");
    writeFileSync(
      file,
      JSON.stringify({
        GITHUB_APP_PRIVATE_KEY: githubPem,
        GITHUB_WEBHOOK_SECRET: "file-gh-secret",
      }),
      { mode: 0o600 }
    );

    const config = loadConfig({
      FORGE: "github",
      GITHUB_APP_ID: "123",
      FORGE_URL: "https://github.com/",
      GITHUB_ALLOWED_ORGS: "acme",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
      [SECRETS_FILE_ENV]: file,
    });

    expect(config.githubAppPrivateKey).toBe(githubPem);
    expect(config.webhookSecret).toBe("file-gh-secret");
    expect(() => readFileSync(file)).toThrow();
  });
});
