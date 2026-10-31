#!/usr/bin/env bun
import { createHash } from "node:crypto";
/**
 * Prove token-only Codex auth against the *installed Codex binary*.
 *
 * Job pods hold no Codex refresh token: `control` owns the login and each pod
 * gets a token-only `auth.json` with `refresh_token: ""`. This probe proves,
 * against the pinned binary, that Codex runs from such a file and never tries
 * to refresh it. It needs no real login and must not use one: every request
 * stays on loopback and the child env carries no API key.
 *
 * How: stand up a loopback API server plus a loopback OAuth token server,
 * point the binary at them with `chatgpt_base_url` / `openai_base_url` and
 * `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, seed an isolated `CODEX_HOME` with a
 * fabricated `auth.json`, and run the real `codex exec`. The access and id
 * tokens are unsigned `alg: none` JWTs minted here; the API server refuses
 * everything with 400 (or 401 where the case needs it), so the model's answer
 * is not under test — the bearer presented, the token POSTs attempted, and
 * the file left behind are.
 *
 * At rust-v0.165.0 the observed behaviour is:
 *   - `refresh_token: ""` loads and runs; the bearer is the seeded access
 *     token, zero token POSTs fire while `exp` is far off, and the file hash
 *     is unchanged. `auth.json` is only written after a successful refresh.
 *   - a missing `refresh_token` key fails to parse, so Codex silently starts
 *     logged out: no bearer, zero token POSTs, still emits a thread.
 *   - a missing `last_refresh` also starts logged out: no bearer.
 *   - a two-part `id_token` fails to parse: no bearer (three parts required).
 *   - a missing top-level `account_id` still sends the bearer, at least while
 *     the id token carries the workspace claim. The source reading that all
 *     three must be present does not hold for `account_id` on this version.
 *   - an access token expiring within 5 minutes triggers a proactive refresh
 *     (the 8-day `last_refresh` interval is only the fallback when `exp`
 *     cannot be read). With `refresh_token: ""` the POST carries the empty
 *     token, fails, leaves the file unchanged, and stderr matches
 *     `CODEX_AUTH_RE` (`Failed to refresh token`).
 *   - a read-only file is safe: far-expiry runs without writing.
 *   - `exec resume` reuses the same token-only auth with zero token POSTs.
 *   - after a 401 Codex re-reads `auth.json` from disk before refreshing: a
 *     symlinked file swapped atomically (the Kubernetes Secret volume shape)
 *     recovers with the new bearer and zero token POSTs.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeCodexAuthDeath } from "./codex.ts";

/** Hang guard per run: loopback answers in seconds, refresh backoff must not hang the image job. */
const RUN_TIMEOUT_MS = 60_000;
const PROBE_MODEL = "gpt-5.5";
const PROBE_ACCOUNT_ID = "acc-jumi-token-probe";

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Unsigned JWT minted for the probe only; never a real credential. */
export function probeJwt(payload: unknown): string {
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

export function probeIdToken(accountId: string = PROBE_ACCOUNT_ID): string {
  return probeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: "u-jumi-probe" },
  });
}

export function probeAccessToken(expSeconds: number, jti = "probe"): string {
  return probeJwt({ exp: expSeconds, jti });
}

export function farExpiry(): number {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
}

export function nearExpiry(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

export interface TokenParts {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId?: string | null;
  readonly lastRefresh?: string | null;
}

/** The token-only shape `control` publishes: empty refresh, far `exp`, fresh `last_refresh`. */
export function tokenOnlyAuth(parts?: Partial<TokenParts>): Record<string, unknown> {
  const tokens: Record<string, unknown> = {
    id_token: parts?.idToken ?? probeIdToken(),
    access_token: parts?.accessToken ?? probeAccessToken(farExpiry()),
    refresh_token: parts?.refreshToken ?? "",
  };
  if (parts && "accountId" in parts) {
    if (parts.accountId !== undefined && parts.accountId !== null) tokens.account_id = parts.accountId;
  } else {
    tokens.account_id = PROBE_ACCOUNT_ID;
  }
  const auth: Record<string, unknown> = { tokens };
  if (parts && "lastRefresh" in parts) {
    if (parts.lastRefresh !== undefined && parts.lastRefresh !== null) auth.last_refresh = parts.lastRefresh;
  } else {
    auth.last_refresh = new Date().toISOString();
  }
  return auth;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function bearerOf(authHeader: string | null): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  return authHeader.slice("Bearer ".length);
}

interface RunOutcome {
  readonly apiRequests: number;
  readonly bearers: readonly (string | null)[];
  readonly tokenPosts: number;
  readonly tokenBodies: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly fileBefore: string;
  readonly fileAfter: string;
}

interface RunOptions {
  readonly readOnly?: boolean;
}

async function runCodexOnce(
  authJson: Record<string, unknown>,
  dir: string,
  opts?: RunOptions
): Promise<RunOutcome & { home: string; codexHome: string; workdir: string }> {
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const workdir = join(dir, "work");
  await mkdir(codexHome, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await Bun.$`git init -q`.cwd(workdir).quiet();
  const authPath = join(codexHome, "auth.json");
  const fileBefore = `${JSON.stringify(authJson, null, 2)}\n`;
  await writeFile(authPath, fileBefore, { mode: 0o600 });
  if (opts?.readOnly) await chmod(authPath, 0o444);

  const bearers: (string | null)[] = [];
  let apiRequests = 0;
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      apiRequests += 1;
      bearers.push(req.headers.get("authorization"));
      return new Response(JSON.stringify({ error: { message: "jumi token probe" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const tokenBodies: string[] = [];
  const token = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      tokenBodies.push(await req.text().catch(() => ""));
      return new Response(JSON.stringify({ error: "jumi token probe: no refresh" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const origin = `http://127.0.0.1:${api.port}`;
  const tokenOrigin = `http://127.0.0.1:${token.port}`;
  // Both base URLs stay on loopback: ChatGPT auth traffic uses
  // `chatgpt_base_url` while the Responses leg uses the `openai` provider's
  // `openai_base_url`. Overriding only `openai_base_url` still sends account
  // and plugin calls at the real backend, which then 401s and draws refresh
  // POSTs even with a far `exp`.
  const argv = [
    "codex",
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "-c",
    `chatgpt_base_url="${origin}"`,
    "-c",
    `openai_base_url="${origin}/v1"`,
    "-c",
    'model_provider="openai"',
    "-c",
    `model="${PROBE_MODEL}"`,
    "say ok",
  ];
  const proc = Bun.spawn(argv, {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: dir,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${tokenOrigin}/oauth/token`,
    },
  });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = out;
    stderr = err;
  } finally {
    clearTimeout(timer);
    api.stop(true);
    token.stop(true);
    if (opts?.readOnly) await chmod(authPath, 0o600).catch(() => undefined);
  }
  let fileAfter = "";
  try {
    fileAfter = await readFile(authPath, "utf8");
  } catch {
    fileAfter = "<unreadable>";
  }
  return {
    apiRequests,
    bearers,
    tokenPosts: tokenBodies.length,
    tokenBodies,
    stdout,
    stderr,
    fileBefore,
    fileAfter,
    home,
    codexHome,
    workdir,
  };
}

/** Kubernetes Secret volume shape: auth.json -> ..data/auth.json, ..data -> ..v1. Swap ..data to ..v2. */
async function seedSecretVolume(
  codexHome: string,
  oldAuth: Record<string, unknown>,
  newAuth: Record<string, unknown>
): Promise<void> {
  const v1 = join(codexHome, "..v1");
  const v2 = join(codexHome, "..v2");
  await mkdir(v1, { recursive: true });
  await mkdir(v2, { recursive: true });
  await writeFile(join(v1, "auth.json"), `${JSON.stringify(oldAuth, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(v2, "auth.json"), `${JSON.stringify(newAuth, null, 2)}\n`, { mode: 0o600 });
  await symlink(v1, join(codexHome, "..data"));
  await symlink(join(codexHome, "..data", "auth.json"), join(codexHome, "auth.json"));
}

async function swapSecretData(codexHome: string): Promise<void> {
  const tmpLink = join(codexHome, "..data.tmp");
  await rm(tmpLink, { force: true });
  await symlink(join(codexHome, "..v2"), tmpLink);
  await rename(tmpLink, join(codexHome, "..data"));
}

function threadStarted(stdout: string): string | undefined {
  return stdout.match(/"thread_id"\s*:\s*"([^"]+)"/)?.[1];
}

function summarizeBearers(bearers: readonly (string | null)[], accessToken: string): string {
  const withBearer = bearers.filter((h) => h === `Bearer ${accessToken}`).length;
  const without = bearers.filter((h) => h !== `Bearer ${accessToken}`).length;
  return `${withBearer} with expected bearer, ${without} other (${bearers.length} total)`;
}

async function caseFarExpiry(): Promise<CaseResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const access = probeAccessToken(farExpiry());
    const outcome = await runCodexOnce(tokenOnlyAuth({ accessToken: access }), dir);
    const presented = outcome.bearers.some((h) => h === `Bearer ${access}`);
    return [
      {
        name: "empty refresh token runs with the seeded bearer",
        ok: presented,
        observed: summarizeBearers(outcome.bearers, access),
      },
      {
        name: "zero token POSTs when exp is far off",
        ok: outcome.tokenPosts === 0,
        observed: `${outcome.tokenPosts} token POST(s)`,
      },
      {
        name: "file hash unchanged when exp is far off",
        ok: outcome.fileAfter === outcome.fileBefore,
        observed:
          outcome.fileAfter === outcome.fileBefore
            ? `sha256 ${sha256Hex(outcome.fileBefore).slice(0, 12)} unchanged`
            : "auth.json was rewritten",
      },
      {
        name: "far-expiry run reaches the model endpoint",
        ok: threadStarted(outcome.stdout) !== undefined && outcome.apiRequests > 0,
        observed: `${outcome.apiRequests} api request(s)`,
      },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseMissingRefreshKey(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const auth = tokenOnlyAuth() as { tokens: Record<string, unknown> };
    delete auth.tokens.refresh_token;
    const outcome = await runCodexOnce(auth, dir);
    const anyBearer = outcome.bearers.some((h) => h?.startsWith("Bearer "));
    return {
      // A missing key fails serde parsing, so the binary silently starts
      // logged out instead of erroring: no bearer, no refresh, still a thread.
      name: "missing refresh_token key starts logged out without refreshing",
      ok: !anyBearer && outcome.tokenPosts === 0 && threadStarted(outcome.stdout) !== undefined,
      observed: anyBearer
        ? "presented a bearer without a refresh key"
        : `${outcome.apiRequests} request(s), no bearer, ${outcome.tokenPosts} token POST(s)`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseMissingLastRefresh(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const auth = tokenOnlyAuth({ lastRefresh: null });
    const outcome = await runCodexOnce(auth, dir);
    const anyBearer = outcome.bearers.some((h) => h?.startsWith("Bearer "));
    return {
      name: "missing last_refresh starts logged out without refreshing",
      ok: !anyBearer && outcome.tokenPosts === 0,
      observed: anyBearer
        ? "presented a bearer without last_refresh"
        : `no bearer, ${outcome.tokenPosts} token POST(s)`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseBadIdToken(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const outcome = await runCodexOnce(tokenOnlyAuth({ idToken: "only.two" }), dir);
    const anyBearer = outcome.bearers.some((h) => h?.startsWith("Bearer "));
    return {
      // The id token must be a three-part JWT: two parts fail parsing and the
      // binary starts logged out.
      name: "two-part id_token starts logged out without refreshing",
      ok: !anyBearer && outcome.tokenPosts === 0,
      observed: anyBearer
        ? "presented a bearer with an unparseable id token"
        : `no bearer, ${outcome.tokenPosts} token POST(s)`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseMissingAccountId(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const access = probeAccessToken(farExpiry());
    const auth = tokenOnlyAuth({ accessToken: access, accountId: null });
    const outcome = await runCodexOnce(auth, dir);
    const presented = outcome.bearers.some((h) => h === `Bearer ${access}`);
    return {
      // Disagrees with the source reading that account_id must be present: at
      // this version a missing top-level account_id still sends the bearer
      // (the id token carries the workspace claim). Assert the real behaviour.
      name: "missing top-level account_id still sends the bearer",
      ok: presented && outcome.tokenPosts === 0,
      observed: summarizeBearers(outcome.bearers, access),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseNearExpiry(): Promise<CaseResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const access = probeAccessToken(nearExpiry());
    const outcome = await runCodexOnce(tokenOnlyAuth({ accessToken: access }), dir);
    const refreshBody = outcome.tokenBodies[0] ?? "";
    return [
      {
        name: "near-expiry token attempts a proactive refresh",
        ok: outcome.tokenPosts > 0,
        observed: `${outcome.tokenPosts} token POST(s)`,
      },
      {
        name: "proactive refresh posts the empty refresh token",
        ok: refreshBody.includes('"refresh_token":""') && refreshBody.includes("proactive_expiry"),
        observed: refreshBody.slice(0, 160) || "<no token POST body>",
      },
      {
        name: "failed refresh leaves the file unchanged",
        ok: outcome.fileAfter === outcome.fileBefore,
        observed: outcome.fileAfter === outcome.fileBefore ? "hash unchanged" : "auth.json was rewritten",
      },
      {
        name: "refresh failure text still matches CODEX_AUTH_RE",
        ok: looksLikeCodexAuthDeath(`${outcome.stderr}\n${outcome.stdout}`),
        observed: looksLikeCodexAuthDeath(`${outcome.stderr}\n${outcome.stdout}`)
          ? "stderr matches the production auth classifier"
          : `stderr did not match: ${outcome.stderr.slice(-300)}`,
      },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseReadOnly(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  try {
    const access = probeAccessToken(farExpiry());
    const outcome = await runCodexOnce(tokenOnlyAuth({ accessToken: access }), dir, { readOnly: true });
    const presented = outcome.bearers.some((h) => h === `Bearer ${access}`);
    return {
      // auth.json is only written after a successful refresh, so a read-only
      // file is safe while exp is far off: the run still presents the bearer
      // and leaves the file alone.
      name: "read-only file runs with the seeded bearer and stays unchanged",
      ok: presented && outcome.tokenPosts === 0 && outcome.fileAfter === outcome.fileBefore,
      observed: `${summarizeBearers(outcome.bearers, access)}, ${outcome.tokenPosts} token POST(s)`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseResume(): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  let api: ReturnType<typeof Bun.serve> | undefined;
  let token: ReturnType<typeof Bun.serve> | undefined;
  try {
    const home = join(dir, "home");
    const codexHome = join(home, ".codex");
    const workdir = join(dir, "work");
    await mkdir(codexHome, { recursive: true });
    await mkdir(workdir, { recursive: true });
    await Bun.$`git init -q`.cwd(workdir).quiet();
    const access = probeAccessToken(farExpiry());
    await writeFile(join(codexHome, "auth.json"), JSON.stringify(tokenOnlyAuth({ accessToken: access }), null, 2));
    const bearers: (string | null)[] = [];
    let tokenPosts = 0;
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        bearers.push(req.headers.get("authorization"));
        return new Response(JSON.stringify({ error: { message: "jumi token probe" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    token = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        tokenPosts += 1;
        await req.text().catch(() => "");
        return new Response("no", { status: 400 });
      },
    });
    const origin = `http://127.0.0.1:${api.port}`;
    const tokenOrigin = `http://127.0.0.1:${token.port}`;
    const env = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: dir,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${tokenOrigin}/oauth/token`,
    };
    const base = [
      "codex",
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "-c",
      `chatgpt_base_url="${origin}"`,
      "-c",
      `openai_base_url="${origin}/v1"`,
      "-c",
      'model_provider="openai"',
      "-c",
      `model="${PROBE_MODEL}"`,
    ];
    const first = Bun.spawn([...base, "say ok"], {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    let timer = setTimeout(() => first.kill(), RUN_TIMEOUT_MS);
    let firstOut = "";
    try {
      const [out] = await Promise.all([
        new Response(first.stdout).text(),
        new Response(first.stderr).text(),
        first.exited,
      ]);
      firstOut = out;
    } finally {
      clearTimeout(timer);
    }
    const threadId = threadStarted(firstOut);
    if (!threadId)
      return { name: "exec resume reuses the token-only auth", ok: false, observed: "first turn emitted no thread_id" };
    bearers.length = 0;
    const resumeArgv = [
      "codex",
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "--model",
      PROBE_MODEL,
      "resume",
      threadId,
      "-c",
      `chatgpt_base_url="${origin}"`,
      "-c",
      `openai_base_url="${origin}/v1"`,
      "-c",
      'model_provider="openai"',
      "-c",
      `model="${PROBE_MODEL}"`,
      "say ok",
    ];
    const second = Bun.spawn(resumeArgv, {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    timer = setTimeout(() => second.kill(), RUN_TIMEOUT_MS);
    try {
      await Promise.all([new Response(second.stdout).text(), new Response(second.stderr).text(), second.exited]);
    } finally {
      clearTimeout(timer);
    }
    const presented = bearers.some((h) => h === `Bearer ${access}`);
    return {
      name: "exec resume reuses the token-only auth",
      ok: presented && tokenPosts === 0,
      observed: presented
        ? `resume presented the bearer, ${tokenPosts} token POST(s)`
        : `resume sent no bearer (${bearers.length} requests)`,
    };
  } finally {
    api?.stop(true);
    token?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseSecretSwap(): Promise<CaseResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-token-probe-"));
  let api: ReturnType<typeof Bun.serve> | undefined;
  let token: ReturnType<typeof Bun.serve> | undefined;
  try {
    const home = join(dir, "home");
    const codexHome = join(home, ".codex");
    const workdir = join(dir, "work");
    await mkdir(codexHome, { recursive: true });
    await mkdir(workdir, { recursive: true });
    await Bun.$`git init -q`.cwd(workdir).quiet();
    const oldAccess = probeAccessToken(farExpiry(), "old-token");
    const newAccess = probeAccessToken(farExpiry(), "new-token");
    await seedSecretVolume(
      codexHome,
      tokenOnlyAuth({ accessToken: oldAccess }),
      tokenOnlyAuth({ accessToken: newAccess })
    );
    const bearers: (string | null)[] = [];
    let tokenPosts = 0;
    let swapped = false;
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const auth = req.headers.get("authorization");
        const url = new URL(req.url);
        if (url.pathname.endsWith("/responses")) {
          bearers.push(auth);
          if (!swapped) {
            swapped = true;
            await swapSecretData(codexHome).catch(() => undefined);
            return new Response(
              JSON.stringify({
                error: { message: "jumi token probe: rotated", type: null, code: "unauthorized", param: null },
                status: 401,
              }),
              { status: 401, headers: { "content-type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ error: { message: "jumi token probe" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        bearers.push(auth);
        return new Response(JSON.stringify({ error: { message: "jumi token probe" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    token = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        tokenPosts += 1;
        await req.text().catch(() => "");
        return new Response("no", { status: 400 });
      },
    });
    const origin = `http://127.0.0.1:${api.port}`;
    const tokenOrigin = `http://127.0.0.1:${token.port}`;
    const proc = Bun.spawn(
      [
        "codex",
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--dangerously-bypass-hook-trust",
        "-c",
        `chatgpt_base_url="${origin}"`,
        "-c",
        `openai_base_url="${origin}/v1"`,
        "-c",
        'model_provider="openai"',
        "-c",
        `model="${PROBE_MODEL}"`,
        "say ok",
      ],
      {
        cwd: workdir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          CODEX_HOME: codexHome,
          TMPDIR: dir,
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${tokenOrigin}/oauth/token`,
        },
      }
    );
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    const sawOld = bearers.some((h) => h === `Bearer ${oldAccess}`);
    const sawNew = bearers.some((h) => h === `Bearer ${newAccess}`);
    let after = "";
    try {
      after = await readFile(join(codexHome, "auth.json"), "utf8");
    } catch {
      after = "";
    }
    return [
      {
        // After a 401 Codex re-reads the file before refreshing, so a Secret
        // volume rotation swapped by atomic rename of ..data recovers without
        // a token POST.
        name: "401 recovers by re-reading the symlinked auth.json",
        ok: sawOld && sawNew,
        observed: sawNew
          ? `old then new bearer seen (${bearers.length} responses calls)`
          : `new bearer never seen (old=${sawOld})`,
      },
      {
        name: "rotation recovery posts no token refresh",
        ok: tokenPosts === 0,
        observed: `${tokenPosts} token POST(s)`,
      },
      {
        name: "rotated file reads back the new token",
        ok: after.includes(newAccess),
        observed: after.includes(newAccess)
          ? "auth.json now holds the new token"
          : "auth.json does not hold the new token",
      },
    ];
  } finally {
    api?.stop(true);
    token?.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const results: CaseResult[] = [];
  results.push(...(await caseFarExpiry()));
  results.push(await caseMissingRefreshKey());
  results.push(await caseMissingLastRefresh());
  results.push(await caseBadIdToken());
  results.push(await caseMissingAccountId());
  results.push(...(await caseNearExpiry()));
  results.push(await caseReadOnly());
  results.push(await caseResume());
  results.push(...(await caseSecretSwap()));
  for (const { name, ok, observed } of results) console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(
      `codex token probe: ${failures}/${results.length} check(s) failed against the installed codex binary`
    );
    return 1;
  }
  console.log(`codex token probe: ${results.length}/${results.length} checks pass against the installed codex binary`);
  return 0;
}

if (import.meta.main) process.exit(await main());
