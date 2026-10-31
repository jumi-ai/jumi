import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_ENV_KEYS } from "../src/config.ts";

const entrypoint = join(import.meta.dir, "../entrypoint.sh");

describe("entrypoint secret scrub", () => {
  test("copies the same secret keys as SECRET_ENV_KEYS", () => {
    const src = readFileSync(entrypoint, "utf8");
    const match = src.match(/const keys = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const keys = [...(match?.[1].matchAll(/"([^"]+)"/g) ?? [])].map((part) => part[1]);
    expect(keys).toEqual([...SECRET_ENV_KEYS]);
    for (const key of SECRET_ENV_KEYS) {
      expect(src).toContain(key);
    }
  });

  test("execs the child with forge secrets absent from its execve environment", () => {
    chmodSync(entrypoint, 0o755);
    const token = `jumi-reexec-token-${crypto.randomUUID()}`;
    const keysJson = JSON.stringify(SECRET_ENV_KEYS);
    // A file, not `bun -e`: macOS only shows the environment through ps, which
    // prints argv too, and this source spells out every key.
    const probe = `
      const environ = process.platform === "linux"
        ? await Bun.file("/proc/self/environ").text()
        : Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(process.pid)]).stdout.toString();
      const keys = ${keysJson};
      const leaked = keys.filter((key) => environ.includes(key) || environ.includes(process.env[key] ?? "${token}"));
      const fileGone = !(await Bun.file(process.env.JUMI_SECRETS_FILE ?? "").exists());
      process.stdout.write(JSON.stringify({
        leaked,
        environSeen: environ.includes("JUMI_ENV_SCRUBBED=1"),
        fileGone,
        hasBot: Boolean(process.env.GITEA_BOT_TOKEN),
        hasSecret: Boolean(process.env.GITEA_WEBHOOK_SECRET),
        hasGithubKey: Boolean(process.env.GITHUB_APP_PRIVATE_KEY),
        hasGithubWebhook: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
        scrubbed: process.env.JUMI_ENV_SCRUBBED,
      }));
    `;
    const probeDir = mkdtempSync(join(tmpdir(), "jumi-scrub-probe-"));
    const probePath = join(probeDir, "probe.ts");
    writeFileSync(probePath, probe);
    const result = spawnSync(entrypoint, [process.execPath, probePath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        GITEA_BOT_TOKEN: token,
        GITEA_WEBHOOK_SECRET: "jumi-reexec-webhook",
        GITEA_WEBHOOK_AUTH_TOKEN: "jumi-reexec-auth",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "jumi-reexec-gh-webhook",
      },
    });
    rmSync(probeDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      leaked: string[];
      environSeen: boolean;
      fileGone: boolean;
      hasBot: boolean;
      hasSecret: boolean;
      hasGithubKey: boolean;
      hasGithubWebhook: boolean;
      scrubbed: string | undefined;
    };
    // The positive control: an unreadable environment must not pass as clean.
    expect(payload.environSeen).toBe(true);
    expect(payload.leaked).toEqual([]);
    expect(payload.hasBot).toBe(false);
    expect(payload.hasSecret).toBe(false);
    expect(payload.hasGithubKey).toBe(false);
    expect(payload.hasGithubWebhook).toBe(false);
    expect(payload.scrubbed).toBe("1");
    expect(payload.fileGone).toBe(false);
  });
});
