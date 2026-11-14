import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeCodexAuthDeath } from "../src/codex.ts";
import {
  CODEX_AUTH_FILE_ENV,
  CODEX_CLOCK_MARGIN_MS,
  CODEX_REFRESH_SKEW_MS,
  codexAuthPath,
  codexJobBudgetMs,
  codexPublishedAccessExpiryMs,
  codexPublishedAuthPath,
  ensureCodexPublishedAuth,
  isCodexChatGptPresent,
  publishedAuthFailureReason,
} from "../src/codex_auth.ts";
import { EngineFailedError } from "../src/engine.ts";
import { REVIEW_SANDBOX_WRAPPER_ENV } from "../src/review_sandbox.ts";

const originalEnv = process.env[CODEX_AUTH_FILE_ENV];
const originalSandboxWrapper = process.env[REVIEW_SANDBOX_WRAPPER_ENV];

/** Silent Landlock stub: answers `--check` like the real wrapper, then execs whatever follows `--`. */
const SANDBOX_STUB = `#!/bin/sh
if [ "$1" = "--check" ]; then echo "landlock-abi=7"; exit 0; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$1" = "--" ] && shift
exec "$@"
`;

afterEach(() => {
  if (originalEnv === undefined) delete process.env[CODEX_AUTH_FILE_ENV];
  else process.env[CODEX_AUTH_FILE_ENV] = originalEnv;
  if (originalSandboxWrapper === undefined) delete process.env[REVIEW_SANDBOX_WRAPPER_ENV];
  else process.env[REVIEW_SANDBOX_WRAPPER_ENV] = originalSandboxWrapper;
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintJwt(payload: unknown): string {
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

function accessToken(expSeconds: number): string {
  return mintJwt({ exp: expSeconds });
}

function idToken(): string {
  return mintJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } });
}

function tokenDoc(opts?: {
  access?: string;
  refresh?: string;
  id?: string;
  lastRefresh?: string | null;
}): Record<string, unknown> {
  const tokens: Record<string, unknown> = {
    id_token: opts?.id ?? idToken(),
    access_token: opts?.access ?? accessToken(Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
    refresh_token: opts?.refresh ?? "",
    account_id: "acc-1",
  };
  const doc: Record<string, unknown> = { tokens };
  if (opts && "lastRefresh" in opts) {
    if (opts.lastRefresh !== null) doc.last_refresh = opts.lastRefresh;
  } else {
    doc.last_refresh = new Date().toISOString();
  }
  return doc;
}

describe("codex published auth path and budget", () => {
  test("unset or empty means local mode", () => {
    expect(codexPublishedAuthPath({})).toBeUndefined();
    expect(codexPublishedAuthPath({ [CODEX_AUTH_FILE_ENV]: "  " })).toBeUndefined();
    expect(codexPublishedAuthPath({ [CODEX_AUTH_FILE_ENV]: "/pub/auth.json" })).toBe("/pub/auth.json");
  });

  test("budget is timeout plus 5-minute skew plus clock margin", () => {
    expect(CODEX_REFRESH_SKEW_MS).toBe(5 * 60 * 1000);
    expect(CODEX_CLOCK_MARGIN_MS).toBe(60_000);
    expect(codexJobBudgetMs(3_600_000)).toBe(3_600_000 + CODEX_REFRESH_SKEW_MS + CODEX_CLOCK_MARGIN_MS);
    expect(codexJobBudgetMs(undefined)).toBe(CODEX_REFRESH_SKEW_MS + CODEX_CLOCK_MARGIN_MS);
  });

  test("reads exp from the access token", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(codexPublishedAccessExpiryMs(accessToken(exp))).toBe(exp * 1000);
    expect(codexPublishedAccessExpiryMs("not-a-jwt")).toBeUndefined();
  });
});

describe("ensureCodexPublishedAuth", () => {
  test("valid file symlinks $HOME/.codex/auth.json at the published file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const home = join(dir, "home");
      const published = join(dir, "published-auth.json");
      await writeFile(published, `${JSON.stringify(tokenDoc(), null, 2)}\n`);
      const out = await ensureCodexPublishedAuth({
        home,
        timeoutMs: 3_600_000,
        env: { [CODEX_AUTH_FILE_ENV]: published },
      });
      expect(out.mode).toBe("published");
      const dest = codexAuthPath(home);
      expect(await readlink(dest)).toBe(published);
      expect((await lstat(join(home, ".codex"))).isDirectory()).toBe(true);
      expect(await readFile(dest, "utf8")).toBe(await readFile(published, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expired token cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const expired = accessToken(Math.floor(Date.now() / 1000) - 3600);
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ access: expired })));
      const doc = JSON.parse(await readFile(published, "utf8")) as unknown;
      expect(publishedAuthFailureReason(doc, codexJobBudgetMs(60_000), Date.now())).toBe("expired");
      await expect(
        ensureCodexPublishedAuth({
          home: join(dir, "home"),
          timeoutMs: 60_000,
          env: { [CODEX_AUTH_FILE_ENV]: published },
        })
      ).rejects.toThrow("expired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("token too short for the budget cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const soon = accessToken(Math.floor(Date.now() / 1000) + 600);
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ access: soon })));
      const doc = JSON.parse(await readFile(published, "utf8")) as unknown;
      expect(publishedAuthFailureReason(doc, codexJobBudgetMs(3_600_000), Date.now())).toBe("too short for budget");
      await expect(
        ensureCodexPublishedAuth({
          home: join(dir, "home"),
          timeoutMs: 3_600_000,
          env: { [CODEX_AUTH_FILE_ENV]: published },
        })
      ).rejects.toThrow("too short for budget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing file cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const missing = join(dir, "does-not-exist.json");
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: missing } })
      ).rejects.toThrow("missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed file cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const published = join(dir, "auth.json");
      await writeFile(published, "not json {");
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: published } })
      ).rejects.toThrow("malformed");
      await writeFile(published, JSON.stringify({ tokens: { access_token: "x" } }));
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: published } })
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a refresh token in the published file is an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ refresh: "secret-refresh" })));
      const doc = JSON.parse(await readFile(published, "utf8")) as unknown;
      expect(publishedAuthFailureReason(doc, codexJobBudgetMs(60_000), Date.now())).toBe("refresh token present");
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: published } })
      ).rejects.toThrow("refresh token present");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unset published file is local mode with no symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const out = await ensureCodexPublishedAuth({ home: join(dir, "home"), env: {} });
      expect(out.mode).toBe("local");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isCodexChatGptPresent in published mode", () => {
  test("reports the published file, not the HOME file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-presence-"));
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const published = join(dir, "published.json");
      await writeFile(published, JSON.stringify(tokenDoc()));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(true);
      await writeFile(published, JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(false);
      expect(await isCodexChatGptPresent(home, {})).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unrunnable published files report absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-presence-"));
    try {
      const home = join(dir, "home");
      const published = join(dir, "published.json");
      const expired = accessToken(Math.floor(Date.now() / 1000) - 60);
      await writeFile(published, JSON.stringify(tokenDoc({ access: expired })));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(false);
      await writeFile(published, JSON.stringify(tokenDoc({ refresh: "secret-refresh" })));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(false);
      await writeFile(published, JSON.stringify(tokenDoc({ lastRefresh: null })));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(false);
      await writeFile(published, JSON.stringify(tokenDoc({ id: "only.two" })));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published })).toBe(false);
      const soon = accessToken(Math.floor(Date.now() / 1000) + 60);
      await writeFile(published, JSON.stringify(tokenDoc({ access: soon })));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published }, { timeoutMs: 3_600_000 })).toBe(
        false
      );
      await writeFile(published, JSON.stringify(tokenDoc()));
      expect(await isCodexChatGptPresent(home, { [CODEX_AUTH_FILE_ENV]: published }, { timeoutMs: 3_600_000 })).toBe(
        true
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("published validation matches the pinned binary", () => {
  test("missing last_refresh cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ lastRefresh: null })));
      const doc = JSON.parse(await readFile(published, "utf8")) as unknown;
      expect(publishedAuthFailureReason(doc, codexJobBudgetMs(60_000), Date.now())).toBe("malformed");
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: published } })
      ).rejects.toThrow("malformed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two-part id_token cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ id: "only.two" })));
      const doc = JSON.parse(await readFile(published, "utf8")) as unknown;
      expect(publishedAuthFailureReason(doc, codexJobBudgetMs(60_000), Date.now())).toBe("malformed");
      await expect(
        ensureCodexPublishedAuth({ home: join(dir, "home"), env: { [CODEX_AUTH_FILE_ENV]: published } })
      ).rejects.toThrow("malformed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("published path pointing at the destination throws without deleting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const home = join(dir, "home");
      const dest = codexAuthPath(home);
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(dest, JSON.stringify(tokenDoc()));
      await expect(
        ensureCodexPublishedAuth({ home, timeoutMs: 60_000, env: { [CODEX_AUTH_FILE_ENV]: dest } })
      ).rejects.toThrow("destination itself");
      expect(JSON.parse(await readFile(dest, "utf8"))).toMatchObject({ tokens: expect.anything() });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an already-correct symlink is left alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const home = join(dir, "home");
      const published = join(dir, "published-auth.json");
      await writeFile(published, `${JSON.stringify(tokenDoc(), null, 2)}\n`);
      const first = await ensureCodexPublishedAuth({
        home,
        timeoutMs: 3_600_000,
        env: { [CODEX_AUTH_FILE_ENV]: published },
      });
      expect(first.mode).toBe("published");
      const second = await ensureCodexPublishedAuth({
        home,
        timeoutMs: 3_600_000,
        env: { [CODEX_AUTH_FILE_ENV]: published },
      });
      expect(second.mode).toBe("published");
      expect(await readlink(codexAuthPath(home))).toBe(published);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("published auth failures hop as auth", () => {
  test("the auth-death message matches the Codex classifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-hop-"));
    try {
      const expired = accessToken(Math.floor(Date.now() / 1000) - 60);
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ access: expired })));
      let caught: unknown;
      try {
        await ensureCodexPublishedAuth({
          home: join(dir, "home"),
          timeoutMs: 60_000,
          env: { [CODEX_AUTH_FILE_ENV]: published },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The runner converts this into the short provider-auth-death message,
      // which the Codex classifier (CODEX_AUTH_RE plus provider death) matches
      // so the chain hops instead of stalling the queue.
      const { providerAuthDeathForRun } = await import("../src/auth.ts");
      const message = providerAuthDeathForRun({
        type: "codex",
        model: "gpt-6-sol",
        trace: { kind: "review" },
      });
      expect(looksLikeCodexAuthDeath(message)).toBe(true);
      const authErr = new EngineFailedError(message, false, { auth: true });
      expect(authErr.auth).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expired published file hops from codex to the next runner", async () => {
    const { chmod } = await import("node:fs/promises");
    const { withEngineChain } = await import("../src/fallback.ts");
    const { registeredEngine } = await import("../src/engine_dispatch.ts");
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-hop-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-hop-work-"));
    const home = await mkdtemp(join(tmpdir(), "jumi-codex-pub-hop-home-"));
    const binDir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-hop-bin-"));
    const originalPath = process.env.PATH;
    try {
      const expired = accessToken(Math.floor(Date.now() / 1000) - 60);
      const published = join(dir, "auth.json");
      await writeFile(published, JSON.stringify(tokenDoc({ access: expired })));
      process.env[CODEX_AUTH_FILE_ENV] = published;
      const argsLog = join(binDir, "args.log");
      const codexBin = join(binDir, "codex");
      await writeFile(codexBin, `#!/bin/sh\nprintf 'codex %s\\n' "$*" >> "$ARGS_LOG"\nexit 1\n`);
      await chmod(codexBin, 0o755);
      const claudeBin = join(binDir, "claude");
      await writeFile(claudeBin, `#!/bin/sh\nprintf 'claude ran\\n'\n`);
      await chmod(claudeBin, 0o755);
      // Review spawns exec through the sandbox wrapper; the stub keeps the
      // wrapped path under test without applying real Landlock rules.
      const stub = join(binDir, "jumi-sandbox-stub");
      await writeFile(stub, SANDBOX_STUB);
      await chmod(stub, 0o755);
      process.env[REVIEW_SANDBOX_WRAPPER_ENV] = stub;
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      const engine = withEngineChain(registeredEngine, {
        chain: [
          { name: "codex", type: "codex", model: "gpt-6-sol", effort: "high" },
          { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" },
        ],
      });
      const result = await engine({
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
      });
      expect(result.status).toBe("ok");
      expect(result.runner?.type).toBe("claude");
    } finally {
      process.env.PATH = originalPath;
      if (originalEnv === undefined) delete process.env[CODEX_AUTH_FILE_ENV];
      else process.env[CODEX_AUTH_FILE_ENV] = originalEnv;
      await rm(dir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
