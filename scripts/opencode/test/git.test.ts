import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AUTH_DEATH_REASON } from "../src/auth.ts";
import { renderRunMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { EngineFailedError } from "../src/engine.ts";
import { withModelHop } from "../src/fallback.ts";
import { FORGE_DENY_DOMAIN, forgePermissions } from "../src/forge_webfetch.ts";
import {
  BLOCKED_BY_REJECTED_PROMPT,
  buildOpenCodeArgs,
  CONFLICT_PROMPT,
  FOLLOWUP_PROMPT,
  IMPLEMENT_PROMPT,
  IMPLEMENT_YIELD_PROMPT,
  resolveOpenCodePrompt,
  runOpenCode,
} from "../src/git.ts";
import { setTraceFetchForTests, traceExportErrors } from "../src/phoenix.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";
import { resetXaiAuthStateForTests } from "../src/xai_auth.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;
const originalPhoenix = process.env.PHOENIX_OTLP_ENDPOINT;
const originalApiKey = process.env.OPENCODE_API_KEY;
const originalApiKeyFile = process.env.OPENCODE_API_KEY_FILE;
const originalHome = process.env.HOME;
// `runOpenCode` owns the provider auth file under HOME before it spawns, so
// every test gets a throwaway one: a real developer or CI home must never be
// read, refreshed, or rewritten by the suite.
let isolatedHome = "";

beforeEach(async () => {
  delete process.env.PHOENIX_OTLP_ENDPOINT;
  delete process.env.OPENCODE_API_KEY_FILE;
  isolatedHome = await mkdtemp(join(tmpdir(), "jumi-opencode-home-"));
  process.env.HOME = isolatedHome;
});

afterEach(async () => {
  resetControlMetricsForTests();
  resetXaiAuthStateForTests();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
  if (originalPhoenix === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalPhoenix;
  if (originalApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalApiKey;
  if (originalApiKeyFile === undefined) delete process.env.OPENCODE_API_KEY_FILE;
  else process.env.OPENCODE_API_KEY_FILE = originalApiKeyFile;
  resetTokenMetricsForTests();
});

/**
 * Shell step that writes one assistant row to the child's session DB, as OpenCode
 * does. The busy timeout is OpenCode's too: without it the parent's quota poll
 * can fail this write with "database is locked", and the row never lands.
 */
function writeAssistantRow(data: unknown): string {
  return `bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.OPENCODE_DB);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)");
db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run("m1", "ses1", "assistant", 1, Date.now(), ${JSON.stringify(JSON.stringify(data))});
db.close();
'`;
}

function retryRow(message: string): unknown {
  return { content: [], retry: { attempt: 2, at: 1, error: { type: "provider.rate-limit", message } } };
}

const PRINT_INLINE_CONFIG = `#!/bin/sh
printf 'CONTENT=%s\\n' "$OPENCODE_CONFIG_CONTENT"
`;

function inlineConfig(stdout: string | undefined): Record<string, unknown> {
  return JSON.parse(/^CONTENT=(.*)$/m.exec(stdout ?? "")?.[1] ?? "{}") as Record<string, unknown>;
}

const FREE_QUOTA_RETRY = writeAssistantRow(retryRow("Free usage exceeded, subscribe to Go"));

async function withFakeOpenCode(script: string, run: (binDir: string, workdir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "fake-opencode-work-")));
  try {
    const bin = join(dir, "opencode");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(dir, workdir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("runOpenCode", () => {
  test("passes a sanitized environment and strips ANSI output", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withFakeOpenCode(
      `#!/bin/sh
printf '\\033[31mHOME=%s MODEL=%s CONFIG=%s DISABLE=%s XDG_CONFIG=%s SECRET=%s ARGS=%s\\033[0m\n' "$HOME" "$OPENCODE_MODEL" "$OPENCODE_CONFIG" "$OPENCODE_DISABLE_PROJECT_CONFIG" "$XDG_CONFIG_HOME" "$GITEA_BOT_TOKEN" "$*"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          configPath: "/config.json",
          home: isolatedHome,
          sanitizeEnv: true,
        });

        expect(result.status).toBe("ok");
        expect(result.stdout).toContain(`HOME=${isolatedHome}`);
        expect(result.stdout).toContain("MODEL=openai/gpt-5.5");
        expect(result.stdout).toContain("CONFIG=/config.json");
        // Empty: the repository's own config loads.
        expect(result.stdout).toContain("DISABLE= XDG_CONFIG=");
        expect(result.stdout).toContain(`XDG_CONFIG=${workdir}/.jumi-tmp/xdg-config`);
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).toContain("run --standalone -m openai/gpt-5.5");
        expect(result.stdout).not.toContain("gpt-5.5#");
        expect(result.stdout).not.toContain("--continue");
        expect(result.stdout).not.toContain("--print-logs");
        expect(result.stdout).not.toContain("\u001b[");
      }
    );
  });

  test("returns the engine result when the prompt temp dir cannot be deleted", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
chmod 500 "$TMPDIR"
echo done
`,
      async (_binDir, workdir) => {
        try {
          const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("done");
        } finally {
          await chmod(join(workdir, ".jumi-tmp"), 0o700);
        }
      }
    );
  });

  test("folds the variant into the model", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ARGS=%s VARIANT=%s\\n' "$*" "$OPENCODE_VARIANT"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          variant: "xhigh",
          workdir,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("run --standalone -m openai/gpt-5.5#xhigh");
        expect(result.stdout).toContain("VARIANT=xhigh");
      }
    );
  });

  test("passes unsupported variant through to OpenCode", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ARGS=%s\\n' "$*"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          variant: "not-a-real-effort",
          workdir,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("openai/gpt-5.5#not-a-real-effort");
      }
    );
  });

  test("omits the variant when it is unset or empty", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ARGS=%s VARIANT=%s\\n' "$*" "$OPENCODE_VARIANT"
`,
      async (_binDir, workdir) => {
        const unset = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          sanitizeEnv: true,
        });
        expect(unset.status).toBe("ok");
        expect(unset.stdout).toContain("run --standalone -m openai/gpt-5.5");
        expect(unset.stdout).not.toContain("gpt-5.5#");
        expect(unset.stdout).toContain("VARIANT=");

        const empty = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          variant: "",
          workdir,
          sanitizeEnv: true,
        });
        expect(empty.status).toBe("ok");
        expect(empty.stdout).not.toContain("gpt-5.5#");
        expect(empty.stdout).toContain("VARIANT=");
      }
    );
  });

  test("continues the last session when continueSession is set", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ARGS=%s\n' "$*"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "write the artifact",
          model: "openai/gpt-5.5",
          workdir,
          continueSession: true,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("run --standalone -m openai/gpt-5.5 --continue");
      }
    );
  });

  test("selects the directory through cwd, not an argument", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ARGS=%s PWD=%s\\n' "$*" "$(pwd)"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
        expect(result.status).toBe("ok");
        expect(result.stdout).not.toContain("--dir");
        expect(result.stdout).toContain(`PWD=${workdir}`);
      }
    );
  });

  test("buildOpenCodeArgs folds the variant and keeps --standalone", () => {
    const run = ["opencode", "run", "--standalone", "-m"];
    expect(buildOpenCodeArgs({ model: "openai/gpt-5.5" })).toEqual([...run, "openai/gpt-5.5"]);
    expect(buildOpenCodeArgs({ model: "openai/gpt-5.5", variant: "xhigh" })).toEqual([...run, "openai/gpt-5.5#xhigh"]);
    expect(buildOpenCodeArgs({ model: "openai/gpt-5.5", continueSession: true })).toEqual([
      ...run,
      "openai/gpt-5.5",
      "--continue",
    ]);
    expect(buildOpenCodeArgs({ model: "openai/gpt-5.5", variant: "xhigh", continueSession: true })).toEqual([
      ...run,
      "openai/gpt-5.5#xhigh",
      "--continue",
    ]);
    expect(buildOpenCodeArgs({ model: "openai/gpt-5.5", variant: "" })).toEqual([...run, "openai/gpt-5.5"]);
  });

  test("forwards extraEnv toolchain vars into the sanitized child", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withFakeOpenCode(
      `#!/bin/sh
printf 'JAVA_HOME=%s TMPOPT=%s GRADLE_HOME=%s DAEMON=%s SECRET=%s PEM=%s\\n' "$JAVA_HOME" "$JAVA_TOOL_OPTIONS" "$GRADLE_USER_HOME" "$GRADLE_OPTS" "$GITEA_BOT_TOKEN" "$GITHUB_APP_PRIVATE_KEY"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          extraEnv: {
            JAVA_HOME: "/opt/java/openjdk",
            JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${workdir}/.jumi-tmp`,
            GRADLE_USER_HOME: "/work/.gradle",
            GRADLE_OPTS: "-Dorg.gradle.daemon=false",
            GITEA_BOT_TOKEN: "should-not-pass",
            GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
          },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("JAVA_HOME=/opt/java/openjdk");
        expect(result.stdout).toContain(`TMPOPT=-Djava.io.tmpdir=${workdir}/.jumi-tmp`);
        expect(result.stdout).toContain("GRADLE_HOME=/work/.gradle");
        expect(result.stdout).toContain("DAEMON=-Dorg.gradle.daemon=false");
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).toContain("PEM=");
        expect(result.stdout).not.toContain("BEGIN PRIVATE KEY");
      }
    );
  });

  test("forwards OPENCODE_API_KEY into the sanitized child", async () => {
    process.env.OPENCODE_API_KEY = "sk-test";
    await withFakeOpenCode(
      `#!/bin/sh
printf 'MODEL=%s KEY=%s\\n' "$OPENCODE_MODEL" "$OPENCODE_API_KEY"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("MODEL=openai/gpt-5.5");
        expect(result.stdout).toContain("KEY=sk-test");
      }
    );
  });

  test("reads OPENCODE_API_KEY_FILE fresh on each spawn without a restart", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "sk-file-one\n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    delete process.env.OPENCODE_API_KEY;
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
        async (_binDir, workdir) => {
          const first = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          expect(first.status).toBe("ok");
          expect(first.stdout).toContain("KEY=sk-file-one");

          await writeFile(keyFile, "sk-file-two\n");
          const second = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          expect(second.status).toBe("ok");
          expect(second.stdout).toContain("KEY=sk-file-two");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("key file wins over the env var", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "sk-from-file\n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    process.env.OPENCODE_API_KEY = "sk-from-env";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("KEY=sk-from-file");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("key file wins over the env var in the unsanitized child", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "sk-from-file\n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    process.env.OPENCODE_API_KEY = "sk-from-env";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("KEY=sk-from-file");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("extraEnv cannot override the file-resolved key", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "sk-from-file\n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    process.env.OPENCODE_API_KEY = "sk-from-env";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({
            prompt: "prompt",
            model: "openai/gpt-5.5",
            workdir,
            sanitizeEnv: true,
            extraEnv: {
              OPENCODE_API_KEY: "sk-from-extra-env",
              OPENCODE_API_KEY_FILE: "/tmp/jumi-spoofed-key",
              GIT_AUTH_HOST: "gitea.example.com",
            },
          });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("KEY=sk-from-file");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("falls back to the env var when the key file is missing", async () => {
    process.env.OPENCODE_API_KEY_FILE = join(tmpdir(), `jumi-missing-key-${Date.now()}`);
    process.env.OPENCODE_API_KEY = "sk-fallback";
    await withFakeOpenCode(
      `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("KEY=sk-fallback");
      }
    );
  });

  test("falls back to the env var when the key file is empty", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "  \n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    process.env.OPENCODE_API_KEY = "sk-fallback";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'KEY=%s\\n' "$OPENCODE_API_KEY"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("KEY=sk-fallback");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("missing key file without an env fallback fails as provider auth", async () => {
    process.env.OPENCODE_API_KEY_FILE = join(tmpdir(), `jumi-missing-key-${Date.now()}`);
    delete process.env.OPENCODE_API_KEY;
    const logs: string[] = [];
    await withFakeOpenCode(
      `#!/bin/sh
printf 'should-not-run\\n'
`,
      async (_binDir, workdir) => {
        const run = runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        await expect(run).rejects.toMatchObject({ name: "EngineFailedError", auth: true, infra: false });
        await expect(run).rejects.toThrow("OPENCODE_API_KEY_FILE");
        await expect(run).rejects.toThrow(AUTH_DEATH_REASON);
        expect(renderRunMetrics()).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
        expect(logs.some((line) => line.includes("OPENCODE_API_KEY_FILE"))).toBe(true);
      }
    );
  });

  test("empty key file without an env fallback fails as provider auth", async () => {
    const keyFile = join(await mkdtemp(join(tmpdir(), "jumi-opencode-key-")), "api-key");
    await writeFile(keyFile, "\n");
    process.env.OPENCODE_API_KEY_FILE = keyFile;
    delete process.env.OPENCODE_API_KEY;
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'should-not-run\\n'
`,
        async (_binDir, workdir) => {
          const run = runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
          await expect(run).rejects.toMatchObject({ name: "EngineFailedError", auth: true, infra: false });
          await expect(run).rejects.toThrow("OPENCODE_API_KEY_FILE");
        }
      );
    } finally {
      await rm(dirname(keyFile), { recursive: true, force: true });
    }
  });

  test("truncates output", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'abcdefghijklmnopqrstuvwxyz'
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          maxOutputBytes: 5,
          sanitizeEnv: true,
        });

        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("abcde\n\n[opencode output truncated at 5 bytes]");
      }
    );
  });

  test("never seeds the child with the xAI refresh token", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-xai-child-"));
    const parentAuth = join(home, ".local", "share", "opencode", "auth.json");
    await mkdir(dirname(parentAuth), { recursive: true });
    await writeFile(
      parentAuth,
      JSON.stringify({
        "https://kirmanak.stream": { type: "wellknown", key: "K", token: "T" },
        xai: { type: "oauth", access: "parent-access", refresh: "parent-refresh", expires: Date.now() + 6 * 3_600_000 },
      })
    );
    try {
      await withFakeOpenCode(
        `#!/bin/sh
cat "$XDG_DATA_HOME/opencode/auth.json"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({
            prompt: "prompt",
            model: "xai/grok-4.6",
            workdir,
            home,
            sanitizeEnv: true,
          });

          expect(result.status).toBe("ok");
          // The child can call the model and cannot rotate the grant.
          expect(result.stdout).toContain("parent-access");
          expect(result.stdout).not.toContain("parent-refresh");
          expect(JSON.parse(result.stdout ?? "{}").xai).toEqual({ type: "api", key: "parent-access" });
          // Other providers are copied through untouched.
          expect(JSON.parse(result.stdout ?? "{}")["https://kirmanak.stream"]).toEqual({
            type: "wellknown",
            key: "K",
            token: "T",
          });
          // The parent's own file still holds the refresh token: removing it
          // while the child runs would be worse than today.
          expect(JSON.parse(await readFile(parentAuth, "utf8")).xai.refresh).toBe("parent-refresh");
        }
      );
    } finally {
      resetXaiAuthStateForTests();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails a Grok run closed when the xAI grant cannot cover it, and lets other models run", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-xai-dead-"));
    const parentAuth = join(home, ".local", "share", "opencode", "auth.json");
    await mkdir(dirname(parentAuth), { recursive: true });
    // Expired, and no refresh token to present: nothing can rescue this run.
    await writeFile(
      parentAuth,
      JSON.stringify({ xai: { type: "oauth", access: "stale-access", expires: Date.now() - 3_600_000 } })
    );
    try {
      await withFakeOpenCode(
        `#!/bin/sh
cat "$XDG_DATA_HOME/opencode/auth.json"
`,
        async (_binDir, workdir) => {
          const logs: string[] = [];
          const run = runOpenCode({
            prompt: "prompt",
            model: "xai/grok-4.6",
            workdir,
            home,
            sanitizeEnv: true,
            logger: (message) => logs.push(message),
          });

          // Public message names the role and runner; the reason stays in the log.
          await expect(run).rejects.toMatchObject({ auth: true });
          expect(logs.some((line) => line.includes("no refresh token"))).toBe(true);
          expect(renderRunMetrics()).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');

          // A spawn on another provider is not blocked by a dead xAI grant,
          // and still cannot rotate it.
          const other = await runOpenCode({
            prompt: "prompt",
            model: "openai/gpt-5.5",
            workdir,
            home,
            sanitizeEnv: true,
          });
          expect(other.status).toBe("ok");
          expect(JSON.parse(other.stdout ?? "{}").xai).toEqual({ type: "api", key: "stale-access" });
        }
      );
    } finally {
      resetXaiAuthStateForTests();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("surfaces non-zero exits with stderr", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'bad things' >&2
exit 7
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.exitCode).toBe(7);
        expect(result.message).toContain("opencode exited with code 7:\nbad things");
        expect(result.infra).toBe(true);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="infra"} 1');
        expect(text).toContain('jumi_job_duration_seconds_count{kind="review",result="infra"} 1');
      }
    );
  });

  test("classifies grant rejection as auth with a short role message", async () => {
    const grant = `oauth token refresh failed: ${"x".repeat(400)} {"error":"invalid_grant","error_description":"refresh token revoked"}`;
    await withFakeOpenCode(
      `#!/bin/sh
printf '%s' '${grant}' >&2
exit 1
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toContain(AUTH_DEATH_REASON);
        expect(result.message).toContain("worker");
        expect(result.message).toContain("opencode/model");
        expect(result.message).not.toContain("invalid_grant");
        expect(result.message).not.toContain("refresh token");
        expect(logs.some((line) => line.includes("[opencode stderr]") && line.includes("invalid_grant"))).toBe(true);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
        expect(text).not.toContain('kind="review",class="incomplete"} 1');
        expect(text).not.toContain("invalid_grant");
      }
    );
  });

  test("classifies provider 401 invalid key as auth, not infra", async () => {
    // Verified against OpenCode provider errors: `ProviderAuthError: Failed to
    // authenticate with ...` and `HTTP 401: Invalid API key.`
    const { looksLikeProviderAuthDeath } = await import("../src/auth.ts");
    expect(looksLikeProviderAuthDeath("ProviderAuthError: Failed to authenticate with openai")).toBe(true);
    expect(looksLikeProviderAuthDeath("HTTP 401: Invalid API key.")).toBe(true);
    await withFakeOpenCode(
      `#!/bin/sh
printf 'ProviderAuthError: Failed to authenticate with openai\\nHTTP 401: Invalid API key.\\n' >&2
exit 1
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toContain(AUTH_DEATH_REASON);
      }
    );
  });

  test("classifies missing provider key as auth, not infra", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'missing API key for provider xai' >&2
exit 1
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toContain(AUTH_DEATH_REASON);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
        expect(text).not.toContain('kind="review",class="infra"} 1');
      }
    );
  });

  test("does not reclassify a quota hit as auth", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${FREE_QUOTA_RETRY}
printf 'invalid_grant\\n' >&2
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("stuck");
        expect(result.quota).toBe("resetting");
        expect(result.auth).toBeFalsy();
        expect(result.infra).toBe(false);
        const text = renderRunMetrics();
        expect(text).not.toContain('kind="review",class="auth"} 1');
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="143"} 1');
        expect(text).not.toContain('kind="review",class="quota"} 1');
      }
    );
  });

  test("timeout stays timeout even when stderr has invalid_grant", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'invalid_grant' >&2
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 100,
        });
        expect(result.status).toBe("timeout");
        expect(result.auth).toBeFalsy();
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="timeout"} 1');
        expect(text).not.toContain('kind="review",class="auth"} 1');
      }
    );
  });

  test("records token totals from OPENCODE_DB even when OpenCode exits non-zero", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY'
import os, sqlite3
path = os.environ["OPENCODE_DB"]
con = sqlite3.connect(path)
con.execute("""
  CREATE TABLE session_v2 (
    model TEXT,
    tokens_input INTEGER,
    tokens_cache_read INTEGER,
    tokens_output INTEGER,
    tokens_cache_write INTEGER,
    tokens_reasoning INTEGER
  )
""")
con.execute(
  "INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)",
  ("xai/grok-4.6", 42, 7, 9, 0, 1),
)
con.commit()
PY
exit 7
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("opencode exited with code 7");
        expect(result.infra).toBe(false);
        const text = renderTokenMetrics();
        expect(text).toContain(
          'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 42'
        );
        expect(text).toContain(
          'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="output"} 9'
        );
      }
    );
  });

  test("kills the child when aborted", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
exec sleep 30
`,
      async (_binDir, workdir) => {
        const abort = new AbortController();
        const run = runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          abortSignal: abort.signal,
        });
        await Bun.sleep(50);
        abort.abort();
        await expect(run).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
      }
    );
  });

  test("caps stderr captured from failed opencode runs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
print('x' * 100000)
PY
exit 7
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("[opencode stderr truncated at");
        expect(result.message).toContain("kept last");
      }
    );
  });

  test("keeps the tail of oversized stderr on failed runs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
import sys
sys.stdout.write("HEADMARKER\\n")
sys.stdout.write("x" * 100000)
sys.stdout.write("\\nTAILMARKER\\n")
PY
exit 7
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("[opencode stderr truncated at");
        expect(result.message).toContain("kept last");
        expect(result.message).toContain("TAILMARKER");
        expect(result.message).not.toContain("HEADMARKER");
      }
    );
  });

  test("logs the captured stderr on success instead of a 2 KiB head", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
print("HEADMARKER")
print("y" * 5000)
print("TAILMARKER")
PY
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        const stderrLog = logs.find((line) => line.includes("[opencode stderr]"));
        expect(stderrLog).toBeDefined();
        expect(stderrLog).toContain("HEADMARKER");
        expect(stderrLog).toContain("TAILMARKER");
        expect(stderrLog!.length).toBeGreaterThan(2000);
        expect(stderrLog).not.toContain("stderr log capped at 2000");
      }
    );
  });

  test("reports a session DB the quota reads cannot use, instead of staying quiet", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.OPENCODE_DB);
db.exec("CREATE TABLE session_message (id TEXT, sessionID TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)");
db.close();
'
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        const line = logs.find((message) => message.includes("event=opencode_quota_schema"));
        expect(line).toContain("session_id");
        expect(renderTokenMetrics()).toContain('ai_quota_db_schema_errors{agent_instance="jumi"} 1');
      }
    );
  });

  test("logs the last 64 KiB of stderr when the child writes more", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
import sys
sys.stdout.write("HEADMARKER\\n")
sys.stdout.write("z" * 100000)
sys.stdout.write("\\nTAILMARKER\\n")
PY
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        const stderrLog = logs.find((line) => line.includes("[opencode stderr]"));
        expect(stderrLog).toBeDefined();
        expect(stderrLog).toContain("TAILMARKER");
        expect(stderrLog).toContain("kept last");
        expect(stderrLog).not.toContain("HEADMARKER");
      }
    );
  });

  test("exports a Phoenix trace after OpenCode exits and ignores export failures", async () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
    const posts: Uint8Array[] = [];
    setTraceFetchForTests(async (_url, init) => {
      posts.push(new Uint8Array(init?.body as Uint8Array));
      return new Response("no", { status: 500 });
    });
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY'
import json, os, sqlite3
path = os.environ["OPENCODE_DB"]
con = sqlite3.connect(path)
con.execute("CREATE TABLE session_v2 (id TEXT, time_created INTEGER, time_updated INTEGER)")
con.execute("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)")
con.execute("INSERT INTO session_v2 VALUES (?, ?, ?)", ("ses1", 1, 2))
con.execute(
  "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)",
  ("msg1", "ses1", "assistant", 1, 1, 2, json.dumps({
    "model": {"id": "grok-4.6", "providerID": "xai"},
    "content": [{
      "type": "tool",
      "name": "bash",
      "state": {
        "status": "error",
        "input": {"command": "pwd"},
        "content": [{"type": "text", "text": "FULL_STDOUT"}],
        "error": {"type": "tool.execution", "message": "boom"},
      },
      "time": {"created": 1, "completed": 2},
    }],
  })),
)
con.commit()
PY
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "review", owner: "personal", repo: "jumi", sha: "abc", jobId: "7" },
        });
        expect(result.status).toBe("ok");
        expect(posts).toHaveLength(1);
        const payload = new TextDecoder().decode(posts[0]);
        expect(payload).toContain("bash");
        expect(payload).toContain("FULL_STDOUT");
        expect(traceExportErrors()).toBe(1);
        expect(renderTokenMetrics()).toContain('ai_trace_exporter_errors{agent_instance="jumi"} 1');
      }
    );
  });

  test("returns timeout when the child is killed by timeoutMs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 100,
        });
        expect(result.status).toBe("timeout");
        expect(result.message).toContain("opencode exited with code");
      }
    );
  });

  test("a retry a killed child left in the reused DB does not abort the resumed child", async () => {
    // A hard kill of the whole process tree leaves `retry` on the row, and
    // `--continue` keeps this DB but never cleans an old subagent session.
    await withFakeOpenCode(
      `#!/bin/sh
exec sleep 0.4
`,
      async (_binDir, workdir) => {
        await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
        const db = new Database(join(workdir, ".jumi-tmp", "opencode-session.db"));
        db.exec(
          "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
        );
        db.query("INSERT INTO session_message VALUES ('m1', 'ses_sub', 'assistant', 9, ?, ?)").run(
          Date.now() - 60_000,
          JSON.stringify(retryRow("Free usage exceeded, subscribe to Go"))
        );
        db.close();
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          continueSession: true,
          quotaPollIntervalMs: 20,
        });
        expect(result.status).toBe("ok");
        expect(result.quota).toBeUndefined();
      }
    );
  });

  test("aborts while running when the session DB shows a Free/Go retry sleep", async () => {
    // Real `opencode run` without --print-logs emits only the banner to stderr,
    // and logs no `stream error` line. The pending retry reaches the assistant
    // row before the multi-hour sleep, so the fake child reproduces that signal
    // (retry row, then sleep), not a stderr line the binary never prints.
    await withFakeOpenCode(
      `#!/bin/sh
${FREE_QUOTA_RETRY}
exec sleep 30
`,
      async (_binDir, workdir) => {
        const startedAt = Date.now();
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("stuck");
        expect(result.message).toContain("usage limit exceeded");
        expect(result.infra).toBe(false);
        expect(result.quota).toBe("resetting");
        expect(result.exitCode).toBe(143);
        // Live abort: must not wait out the 30s sleep.
        expect(Date.now() - startedAt).toBeLessThan(20_000);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="143"} 1');
        expect(text).not.toContain('kind="review",class="quota"} 1');
      }
    );
  });

  test("hop-yes quota SIGTERM is class quota, not 143", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-m" ]; then model="$arg"; fi
  prev="$arg"
done
case "$model" in
  anthropic/*)
    printf 'ok\\n'
    exit 0
    ;;
esac
${FREE_QUOTA_RETRY}
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await withModelHop(runOpenCode, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
          prompt: "prompt",
          model: "opencode/big-pickle",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("ok");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="quota"} 1');
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="ok"} 1');
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="143"} 0');
      }
    );
  });

  test("quota SIGTERM stays 143 when lease is too short to hop", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${FREE_QUOTA_RETRY}
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await withModelHop(runOpenCode, {
          fallbackModel: "anthropic/claude-sonnet-4-6",
          remainingLeaseMs: () => 1,
        })({
          prompt: "prompt",
          model: "opencode/big-pickle",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
          timeoutMs: 900_000,
        });
        expect(result.status).toBe("stuck");
        expect(result.exitCode).toBe(143);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="143"} 1');
        expect(text).not.toContain('kind="review",class="quota"} 1');
      }
    );
  });

  test("quota poll is independent of the memory sampler", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${writeAssistantRow(retryRow("Go limit reached"))}
exec sleep 30
`,
      async (_binDir, workdir) => {
        const startedAt = Date.now();
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          memorySampleIntervalMs: 0,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("stuck");
        expect(Date.now() - startedAt).toBeLessThan(20_000);
      }
    );
  });

  test("does not abort on bare usage-limit text without a Free/Go distinguisher", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${writeAssistantRow(retryRow("my-model usage limit reached, retry in 5s"))}
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("ok");
      }
    );
  });

  test("does not abort on an ordinary 429 retry", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${writeAssistantRow(retryRow("429 Too Many Requests"))}
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("ok");
      }
    );
  });

  test("does not abort on assistant text quoting quota strings", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${writeAssistantRow({ content: [{ type: "text", text: "grep FreeUsageLimitError" }] })}
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("ok");
      }
    );
  });

  test("does not abort on stderr tool traces containing quota literals", async () => {
    // The live signal is the session DB, not the stderr stream: any
    // tool trace or echoed file content containing quota literals must not
    // kill a healthy run or set the human-clear quota flag.
    await withFakeOpenCode(
      `#!/bin/sh
printf 'FreeUsageLimitError in tool output\\n' >&2
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
        });
        expect(result.status).toBe("ok");
      }
    );
  });

  test("returns timeout when the child traps TERM and exits 0", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
trap 'kill "$pid"; exit 0' TERM
sleep 30 >/dev/null 2>&1 &
pid=$!
: > trap-armed
wait "$pid"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 50,
          // The timeout clock starts after onPid, so TERM can only land on a
          // child that has installed its handler, however slow the exec was.
          onPid: async () => {
            while (!(await Bun.file(join(workdir, "trap-armed")).exists())) await Bun.sleep(5);
          },
        });
        expect(result.status).toBe("timeout");
        expect(result.exitCode).toBe(0);
        expect(result.message).toContain("opencode exited with code");
      }
    );
  });

  test("synthesizes implement stdin when the kernel omits prompt", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
cat
`,
      async (_binDir, workdir) => {
        await writeFile(join(workdir, "JUMI_TASK.md"), "# Fix the thing\n");
        const result = await runOpenCode({
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe(IMPLEMENT_PROMPT);
      }
    );
  });

  test("feeds the review task file as OpenCode stdin", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
cat
`,
      async (_binDir, workdir) => {
        await writeFile(join(workdir, "JUMI_TASK.md"), "review-context-xml");
        const result = await runOpenCode({
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "review", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("review-context-xml");
      }
    );
  });

  test("overlays reviewer webfetch last-match via OPENCODE_CONFIG_CONTENT", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const result = await runOpenCode({
        prompt: "prompt",
        model: "model",
        workdir,
        sanitizeEnv: true,
        trace: { kind: "review", owner: "kirmanak", repo: "demo" },
      });
      expect(result.status).toBe("ok");
      expect(inlineConfig(result.stdout).permissions).toEqual(forgePermissions(FORGE_DENY_DOMAIN));
    });
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const result = await runOpenCode({
        prompt: "prompt",
        model: "model",
        workdir,
        sanitizeEnv: true,
        configPath: "/app/.gitea/opencode-review.json",
      });
      expect(result.status).toBe("ok");
      expect(inlineConfig(result.stdout).permissions).toEqual(forgePermissions(FORGE_DENY_DOMAIN));
    });
  });

  test("overlays the same forge webfetch deny on worker OpenCode", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      for (const kind of ["implement", "follow-up", "conflict"] as const) {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          configPath: "/app/.gitea/opencode-implement.json",
          trace: { kind, owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(inlineConfig(result.stdout).permissions).toEqual(forgePermissions(FORGE_DENY_DOMAIN));
      }
    });
  });

  test("denies the forge host even when the job env tries to loosen it", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const loosen = { action: "webfetch", resource: "*", effect: "allow" };
      const result = await runOpenCode({
        prompt: "prompt",
        model: "model",
        workdir,
        sanitizeEnv: true,
        configPath: "/app/.gitea/opencode-implement.json",
        trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        extraEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permissions: [loosen], share: "disabled" }) },
      });
      expect(result.status).toBe("ok");
      const config = inlineConfig(result.stdout);
      // Last-match: the deny has to come after whatever the job supplied.
      expect(config.permissions).toEqual([loosen, ...forgePermissions(FORGE_DENY_DOMAIN)]);
      expect(config.share).toBe("disabled");
    });
  });

  test("still sets the deny when the job env's inline config is unreadable", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const result = await runOpenCode({
        prompt: "prompt",
        model: "model",
        workdir,
        sanitizeEnv: true,
        extraEnv: { OPENCODE_CONFIG_CONTENT: "{not json" },
      });
      expect(inlineConfig(result.stdout).permissions).toEqual(forgePermissions(FORGE_DENY_DOMAIN));
    });
  });

  test("denies the forge host this spawn authenticates against, not a baked one", async () => {
    // GitHub factory: gitEnv hands the child GIT_AUTH_HOST=github.com with a
    // write-capable token, so the deny must follow that host.
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const result = await runOpenCode({
        prompt: "prompt",
        model: "model",
        workdir,
        sanitizeEnv: true,
        configPath: "/app/.gitea/opencode-implement.json",
        trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        extraEnv: { GIT_AUTH_HOST: "github.com", GIT_AUTH_TOKEN: "write-capable" },
      });
      expect(result.status).toBe("ok");
      expect(inlineConfig(result.stdout).permissions).toEqual(forgePermissions("github.com"));
      expect(result.stdout).toContain("*github.com*");
    });
  });

  test("keeps the forge webfetch deny when the parent env is inherited", async () => {
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    const loosen = { action: "webfetch", resource: "*", effect: "allow" };
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permissions: [loosen] });
    try {
      await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(inlineConfig(result.stdout).permissions).toEqual([loosen, ...forgePermissions(FORGE_DENY_DOMAIN)]);
      });
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  test("leaves AGENTS.md to OpenCode's own project discovery", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      const result = await runOpenCode({ prompt: "p", model: "m", workdir, home: isolatedHome, sanitizeEnv: true });
      expect(inlineConfig(result.stdout).instructions).toBeUndefined();
    });
  });

  test("hands each sanitized spawn the forge policy for its own host, where a repo cannot lift it", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'POLICY=%s\\n' "$(cat "$XDG_CONFIG_HOME/opencode/opencode.json")"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "p",
          model: "m",
          workdir,
          home: isolatedHome,
          sanitizeEnv: true,
          extraEnv: { GIT_AUTH_HOST: "gitea.example.com:3000" },
        });
        const policy = JSON.parse(/^POLICY=(.*)$/m.exec(result.stdout ?? "")?.[1] ?? "{}") as {
          policies?: { resource: string; effect: string }[];
        };
        expect(policy.policies?.[0]).toMatchObject({ resource: "webfetch:*gitea.example.com*", effect: "deny" });
      }
    );
  });

  test("refuses to start a sanitized spawn that cannot take the forge policy", async () => {
    await withFakeOpenCode(PRINT_INLINE_CONFIG, async (_binDir, workdir) => {
      await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
      await writeFile(join(workdir, ".jumi-tmp", "xdg-config"), "a file where the directory goes");
      await expect(
        runOpenCode({ prompt: "p", model: "m", workdir, home: isolatedHome, sanitizeEnv: true })
      ).rejects.toThrow();
    });
  });

  test("reads OPENCODE_CONFIG from the environment when configPath is omitted", async () => {
    const previous = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = "/from-env.json";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'CONFIG=%s\n' "$OPENCODE_CONFIG"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({
            prompt: "prompt",
            model: "model",
            workdir,
            sanitizeEnv: true,
          });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("CONFIG=/from-env.json");
        }
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previous;
    }
  });

  test("PATH miss throws infra EngineFailedError before the child runs", async () => {
    const workdir = await realpath(await mkdtemp(join(tmpdir(), "fake-opencode-work-")));
    process.env.PATH = "/nonexistent";
    try {
      await expect(runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true })).rejects.toMatchObject(
        {
          name: "EngineFailedError",
          infra: true,
        }
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

describe("opencode binary", () => {
  test("refuses the spawn when the opencode binary is missing", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-binary-missing-"));
    process.env.PATH = "/nonexistent";
    try {
      let caught: unknown;
      try {
        await runOpenCode({ prompt: "prompt", model: "openai/gpt-5.5", workdir, sanitizeEnv: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineFailedError);
      expect(caught).toMatchObject({ infra: true, auth: false });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

describe("worker prompts", () => {
  const prompts = [IMPLEMENT_PROMPT, FOLLOWUP_PROMPT, CONFLICT_PROMPT];

  test("keep the child in the worktree on the injected brief", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("Stay in this clone");
      expect(prompt).toContain("do not glob **/*");
      expect(prompt).toContain("Do not webfetch this Gitea host");
      expect(prompt).toContain("Do not call tea or the forge API");
      expect(prompt).toContain("Public upstream docs are fine");
      expect(prompt).toContain("Grep is ripgrep syntax, not JavaScript");
      expect(prompt).toContain("Ignore .jumi-tmp, including opencode-prompt-*/prompt.txt");
      expect(prompt).toContain("JUMI_QUEUE.md");
      expect(prompt).toContain("JUMI_PR.md");
      expect(prompt).toContain("Verify once at the end");
      expect(prompt).toContain("Do not ask questions");
      expect(prompt).not.toContain("denied");
      expect(prompt).not.toContain("Do not run git");
    }
  });

  test("workers commit per logical step and never push", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("Commit at each coherent logical step");
      expect(prompt).toContain("Do not push");
      expect(prompt).toContain("The parent pushes once after this run exits");
      expect(prompt).toContain("Do not force-push");
      expect(prompt).toContain("Do not amend or rebase commits already on the remote branch");
      expect(prompt).toContain("Do not commit JUMI_*.md sentinels");
      expect(prompt).not.toContain("push as needed");
    }
    expect(IMPLEMENT_PROMPT).toContain("a small task can be a single commit");
    expect(IMPLEMENT_PROMPT).toContain("No `wip`");
    expect(IMPLEMENT_PROMPT).toContain("Do not commit a broken intermediate state");
    expect(FOLLOWUP_PROMPT).toContain("a small task can be a single commit");
    expect(CONFLICT_PROMPT).toContain("a small task can be a single commit");
    expect(CONFLICT_PROMPT).toContain("Keep the merge commit flow");
  });

  test("conflict stays on the injected conflicted paths", () => {
    expect(CONFLICT_PROMPT).toContain("Resolve only the conflicted paths listed in JUMI_CONFLICT.md");
    expect(CONFLICT_PROMPT).toContain("One adjacent file is allowed only if the resolution truly requires it");
  });

  test("follow-up and conflict must not yield", () => {
    expect(FOLLOWUP_PROMPT).not.toContain("JUMI_BLOCKED.md");
    expect(CONFLICT_PROMPT).not.toContain("JUMI_BLOCKED.md");
    expect(FOLLOWUP_PROMPT).not.toContain("jumi-blocked-by");
    expect(CONFLICT_PROMPT).not.toContain("jumi-blocked-by");
  });

  test("follow-up judges leftover simplifications and may no-op", () => {
    expect(FOLLOWUP_PROMPT).toContain("Leftover simplifications");
    expect(FOLLOWUP_PROMPT).toContain("A clean tree is a valid outcome");
  });

  test("first-run may yield a queue id then stop", () => {
    expect(IMPLEMENT_YIELD_PROMPT).toContain("JUMI_QUEUE.md");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("JUMI_BLOCKED.md");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("<!-- jumi-blocked-by: #N -->");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("Do not commit");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("Do not push");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("Do not implement a guess");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("new abstraction");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("cluster pin");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("live image");
    expect(BLOCKED_BY_REJECTED_PROMPT.startsWith("blocked-by rejected, implement")).toBe(true);
    expect(IMPLEMENT_PROMPT).not.toContain("JUMI_BLOCKED.md");
  });

  test("first-run skip is JUMI_SKIP.md; follow-up and conflict must not skip", () => {
    expect(IMPLEMENT_PROMPT).toContain("JUMI_SKIP.md");
    expect(IMPLEMENT_YIELD_PROMPT).toContain("JUMI_SKIP.md");
    expect(BLOCKED_BY_REJECTED_PROMPT).toContain("JUMI_SKIP.md");
    expect(FOLLOWUP_PROMPT).not.toContain("JUMI_SKIP.md");
    expect(CONFLICT_PROMPT).not.toContain("JUMI_SKIP.md");
  });
});

describe("resolveOpenCodePrompt", () => {
  test("prefers an explicit prompt", async () => {
    expect(await resolveOpenCodePrompt({ prompt: "explicit", model: "m", workdir: "/tmp" })).toBe("explicit");
  });

  test("uses workspace files when prompt is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-prompt-"));
    try {
      await writeFile(join(dir, "JUMI_TASK.md"), "task");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(IMPLEMENT_PROMPT);
      await writeFile(join(dir, "JUMI_FEEDBACK.md"), "feedback");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(FOLLOWUP_PROMPT);
      await writeFile(join(dir, "JUMI_CONFLICT.md"), "conflict");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(CONFLICT_PROMPT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runOpenCode child lifecycle", () => {
  const SEEDED_AUTH = JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 1 } });

  async function seedHomeAuth(home: string): Promise<void> {
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await writeFile(join(home, ".local", "share", "opencode", "auth.json"), SEEDED_AUTH);
  }

  test("reports a child killed by SIGTERM as 143, not the 130 the CLI exits with", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
trap 'exit 130' TERM
sleep 30 >/dev/null 2>&1 &
wait
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          home: isolatedHome,
          sanitizeEnv: true,
          timeoutMs: 200,
        });
        expect(result.status).toBe("timeout");
        expect(result.exitCode).toBe(143);
      }
    );
  });

  test("runs the child in workdir when the parent's PWD points elsewhere", async () => {
    const originalPwd = process.env.PWD;
    process.env.PWD = "/somewhere/else";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'PWD=%s\n' "$PWD"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({
            prompt: "prompt",
            model: "openai/gpt-5.5",
            workdir,
            home: isolatedHome,
            sanitizeEnv: false,
          });
          expect(result.stdout).toContain(`PWD=${workdir}`);
        }
      );
    } finally {
      if (originalPwd === undefined) delete process.env.PWD;
      else process.env.PWD = originalPwd;
    }
  });

  test("carries the retry-after of the quota retry the child is sleeping on", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
${writeAssistantRow({
  content: [],
  retry: {
    attempt: 2,
    at: 1,
    error: {
      type: "provider.rate-limit",
      message: "Rate limit exceeded. Please try again later.",
      retryAfterMs: 7200000,
    },
  },
})}
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          home: isolatedHome,
          sanitizeEnv: true,
          quotaPollIntervalMs: 50,
          timeoutMs: 20_000,
        });
        expect(result.status).toBe("stuck");
        expect(result.quota).toBe("resetting");
        expect(result.retryAfterMs).toBe(7_200_000);
      }
    );
  });

  test("bootstraps the child's DB and re-arms the credential import before the run", async () => {
    await seedHomeAuth(isolatedHome);
    await withFakeOpenCode(
      `#!/bin/sh
if [ "$1" = "auth" ]; then
  printf '%s\n' "$*" >> "$XDG_DATA_HOME/bootstrap-args"
  exec bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.OPENCODE_DB);
db.exec("CREATE TABLE migration (id TEXT PRIMARY KEY); CREATE TABLE credential (integration_id TEXT)");
db.exec("INSERT INTO migration VALUES (\\x2720260805200742_import_legacy_credentials\\x27), (\\x27other\\x27)");
db.exec("INSERT INTO credential VALUES (\\x27xai\\x27), (\\x27openai\\x27)");
db.close();
'
fi
cat "$XDG_DATA_HOME/bootstrap-args"
cat "$XDG_DATA_HOME/opencode/auth.json"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          home: isolatedHome,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("auth export --standalone");
        expect(result.stdout).toContain('"refresh": "r"');

        const db = new Database(join(workdir, ".jumi-tmp", "opencode-session.db"), { readonly: true });
        const migrations = db.query("SELECT id FROM migration").all() as Array<{ id: string }>;
        const credentials = db.query("SELECT integration_id FROM credential").all() as Array<{
          integration_id: string;
        }>;
        db.close();
        expect(migrations.map((row) => row.id)).toEqual(["other"]);
        // The xAI row goes so a rewritten key is imported; other providers keep
        // whatever the child already refreshed.
        expect(credentials.map((row) => row.integration_id)).toEqual(["openai"]);
      }
    );
  });

  test("a failed bootstrap does not stop the run: env-only auth still works", async () => {
    await seedHomeAuth(isolatedHome);
    await withFakeOpenCode(
      `#!/bin/sh
if [ "$1" = "auth" ]; then exit 1; fi
echo ran
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          home: isolatedHome,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("ran");
        expect(logs.join("\n")).toContain("credential bootstrap");
      }
    );
  });
});
