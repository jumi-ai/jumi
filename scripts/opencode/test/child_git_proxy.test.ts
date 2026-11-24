import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChildGitProxyAccess,
  childProxyGitConfigEnv,
  childProxyRequestFrom,
  extraEnvHasGitToken,
  isChildStrippedKey,
  isGitPathAllowed,
  isGitRequestAllowed,
  startChildGitProxy,
} from "../src/child_git_proxy.ts";
import { workerOpenCodeChildEnv } from "../src/workspace.ts";

const AUTH = {
  giteaUrl: "https://forge.example.com/",
  username: "jumi",
  token: "worker-secret-token-xyz",
};

async function collectFileText(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (entry === ".git") continue;
    const path = join(root, entry);
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes(needle)) hits.push(path);
  }
  return hits;
}

describe("child git proxy allowlist", () => {
  test("allows only the claimed repo git smart-HTTP endpoints, never the web UI, API, or attachments", () => {
    expect(isGitPathAllowed("/o/r.git/info/refs", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r.git/git-upload-pack", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r.git/git-receive-pack", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r.git/HEAD", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r.git/objects/info/packs", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r.git/objects/ab/cdef0123456789", "o", "r")).toBe(true);
    // Bare (`/owner/repo/...`, which Gitea also serves) needs the same suffix.
    expect(isGitPathAllowed("/o/r/info/refs", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r/HEAD", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r/git-upload-pack", "o", "r")).toBe(true);
    expect(isGitPathAllowed("/o/r/objects/info/packs", "o", "r")).toBe(true);
    // The repo root and every web-UI page authenticate nothing through the proxy.
    expect(isGitPathAllowed("/o/r", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r/", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r.git", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r/issues", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r/pulls/1", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r/raw/branch/README.md", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r/archive/main.zip", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/issues", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/archive/main.zip", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/api/v1/repos/o/r", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/attachments/uuid", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/other/repo.git/info/refs", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/other/r/info/refs", "o", "r")).toBe(false);
    expect(isGitPathAllowed("/api/v1/repos/o/r")).toBe(false);
    expect(isGitPathAllowed("/attachments/uuid")).toBe(false);
  });

  test("fails closed without a valid scope: unscoped proxies serve nothing", async () => {
    expect(isGitPathAllowed("/any/repo.git/info/refs")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/info/refs")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/info/refs", "", "r")).toBe(false);
    expect(isGitPathAllowed("/o/r.git/info/refs", "o", "")).toBe(false);
    expect(isGitPathAllowed("/api/v1/repos/o/r")).toBe(false);
    await expect(
      startChildGitProxy({ forgeUrl: AUTH.giteaUrl, username: AUTH.username, token: AUTH.token })
    ).rejects.toThrow(/scope/);
    await expect(
      startChildGitProxy({ forgeUrl: AUTH.giteaUrl, username: AUTH.username, token: AUTH.token, owner: "o" })
    ).rejects.toThrow(/scope/);
  });

  test("a token without a routable forge origin is a refused spawn, not a direct env leak", () => {
    const extraEnv = workerOpenCodeChildEnv(AUTH, "/tmp/jumi-no-forge");
    expect(extraEnvHasGitToken(extraEnv)).toBe(true);
    expect(extraEnvHasGitToken({})).toBe(false);
    expect(extraEnvHasGitToken({ GIT_AUTH_TOKEN: "  " })).toBe(false);
    // Empty host / invalid URL: no proxy request, so every runner must refuse
    // the spawn instead of handing the child the token (covered by the
    // `extraEnvHasGitToken` refusal branch in each engine).
    expect(childProxyRequestFrom({ ...extraEnv, GIT_AUTH_HOST: "" }, { owner: "o", repo: "r" })).toBeUndefined();
    expect(childProxyRequestFrom({ ...extraEnv, GIT_AUTH_URL: "://bad" }, { owner: "o", repo: "r" })).toBeUndefined();
    expect(childProxyRequestFrom(extraEnv, { owner: "o", repo: "r" })?.token).toBe(AUTH.token);
  });

  test("stripped keys never reach the child", () => {
    expect(isChildStrippedKey("GIT_AUTH_TOKEN")).toBe(true);
    expect(isChildStrippedKey("GIT_AUTH_URL")).toBe(true);
    expect(isChildStrippedKey("GIT_CONFIG_COUNT")).toBe(true);
    expect(isChildStrippedKey("GIT_CONFIG_KEY_0")).toBe(true);
    expect(isChildStrippedKey("GIT_CONFIG_VALUE_3")).toBe(true);
    expect(isChildStrippedKey("GIT_AUTH_HOST")).toBe(false);
    expect(isChildStrippedKey("GIT_AUTH_USERNAME")).toBe(false);
    expect(isChildStrippedKey("JAVA_HOME")).toBe(false);
  });
});

describe("worker child env for each runner type", () => {
  test("no token in child env, workdir, or HOME; proxy config points at loopback", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-child-work-"));
    const home = await mkdtemp(join(tmpdir(), "jumi-child-home-"));
    const proxyHomes: string[] = [];
    try {
      const extraEnv = workerOpenCodeChildEnv(AUTH, workdir);
      // Parent-side extraEnv still carries the token so the parent can start
      // the proxy; the child process must never see it.
      expect(extraEnv.GIT_AUTH_TOKEN).toBe(AUTH.token);

      const trace = { owner: "o", repo: "r" };
      const request = childProxyRequestFrom(extraEnv, trace);
      expect(request?.token).toBe(AUTH.token);

      const proxy = await startChildGitProxy(request!);
      proxyHomes.push(proxy.url);
      try {
        const proxyEnv = childProxyGitConfigEnv(proxy.url, {
          forgeUrl: request!.forgeUrl,
          forgeHost: request!.forgeHost,
        });
        // Simulate what each of the four engines does: copy extraEnv minus
        // stripped keys, then add the proxy GIT_CONFIG.
        const buildFinal = (runnerExtra: Record<string, string>): Record<string, string> => {
          const out: Record<string, string> = {
            HOME: home,
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            TMPDIR: join(workdir, ".jumi-tmp", "scratch"),
          };
          for (const [k, v] of Object.entries(runnerExtra)) {
            if (k.startsWith("GITEA_") || k.startsWith("GITHUB_APP_")) continue;
            if (isChildStrippedKey(k)) continue;
            out[k] = v;
          }
          return { ...out, ...proxyEnv };
        };

        const runnerNames = ["opencode", "claude", "agy", "codex"] as const;
        for (const _runner of runnerNames) {
          const finalEnv = buildFinal(extraEnv);
          // Spawn a real child with exactly this env and read it back.
          const proc = Bun.spawn(["env"], { stdout: "pipe", stderr: "pipe", env: finalEnv });
          const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          expect(code).toBe(0);
          expect(out).not.toContain(AUTH.token);
          expect(out).not.toContain("GIT_AUTH_TOKEN=");
          // The proxy URL is loopback-only and carries no credentials.
          expect(finalEnv.GIT_CONFIG_KEY_0 ?? "").toContain("http://127.0.0.1:");
          expect(JSON.stringify(finalEnv)).not.toContain(AUTH.token);
          // Non-secret host/username stay for the webfetch deny.
          expect(finalEnv.GIT_AUTH_HOST).toBeTruthy();
        }

        // Nothing the child can read from the workdir or HOME contains the token.
        const workHits = await collectFileText(workdir, AUTH.token);
        expect(workHits).toEqual([]);
        const homeHits = await collectFileText(home, AUTH.token);
        expect(homeHits).toEqual([]);
      } finally {
        await proxy.close();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("proxy forwards git, blocks the forge API", () => {
  test("child pushes through the proxy; API/attachments built from child-readable values fail", async () => {
    const seenAuth: string[] = [];
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/")) {
          if (auth !== `Basic ${Buffer.from(`${AUTH.username}:${AUTH.token}`).toString("base64")}`) {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.pathname.startsWith("/o/r.git/")) {
          seenAuth.push(auth);
          if (auth !== `Basic ${Buffer.from(`${AUTH.username}:${AUTH.token}`).toString("base64")}`) {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response("git-ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const forgeBase = `http://127.0.0.1:${forge.port}/`;
    try {
      const proxy = await startChildGitProxy({
        forgeUrl: forgeBase,
        username: AUTH.username,
        token: AUTH.token,
        owner: "o",
        repo: "r",
      });
      try {
        // Git smart-HTTP through the proxy succeeds without the child holding the token.
        const gitRes = await fetch(`${proxy.url}o/r.git/info/refs?service=git-upload-pack`);
        expect(gitRes.status).toBe(200);
        expect(await gitRes.text()).toBe("git-ok");
        expect(seenAuth.at(-1)).toBe(`Basic ${Buffer.from(`${AUTH.username}:${AUTH.token}`).toString("base64")}`);

        // The proxy refuses the forge API and attachments without ever contacting the forge.
        for (const path of ["api/v1/repos/o/r", "attachments/uuid", "api/v1/users/jumi"]) {
          const blocked = await fetch(`${proxy.url}${path}`);
          expect([401, 403, 404]).toContain(blocked.status);
        }

        // A direct forge request with no credentials fails (what a child without
        // the token gets when it tries the web UI or /api).
        const directApi = await fetch(`${forgeBase}api/v1/repos/o/r`);
        expect([401, 403, 404]).toContain(directApi.status);
        const directAttach = await fetch(`${forgeBase}attachments/uuid`);
        expect([401, 403, 404]).toContain(directAttach.status);

        // Anything the child can read (proxy URL, host, username) cannot
        // authenticate the API: only the parent-held token can.
        const childReadable = [proxy.url, "o", "r", AUTH.username, "127.0.0.1"];
        for (const candidate of childReadable) {
          const attempt = await fetch(`${forgeBase}api/v1/repos/o/r`, {
            headers: { authorization: `Basic ${Buffer.from(`jumi:${candidate}`).toString("base64")}` },
          });
          expect([401, 403, 404]).toContain(attempt.status);
        }
      } finally {
        await proxy.close();
      }
    } finally {
      forge.stop();
    }
  });

  test("child git still commits and pushes the claimed branch with proxy env present", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-git-work-"));
    const bare = await mkdtemp(join(tmpdir(), "jumi-git-bare-"));
    try {
      const extraEnv = workerOpenCodeChildEnv(AUTH, workdir);
      const request = childProxyRequestFrom(extraEnv, { owner: "o", repo: "r" });
      const proxy = await startChildGitProxy(request!);
      try {
        const proxyEnv = childProxyGitConfigEnv(proxy.url, {
          forgeUrl: request!.forgeUrl,
          forgeHost: request!.forgeHost,
        });
        const childEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? workdir,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "jumi",
          GIT_AUTHOR_EMAIL: "jumi@example.com",
          GIT_COMMITTER_NAME: "jumi",
          GIT_COMMITTER_EMAIL: "jumi@example.com",
          ...proxyEnv,
        };
        const git = async (args: string[], cwd: string) => {
          const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: childEnv });
          const [out, errText, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${errText}`);
          return out.trim();
        };
        await git(["init", "--bare", bare], workdir);
        await git(["init"], workdir);
        await git(["checkout", "-B", "jumi/issue-1-task"], workdir);
        await Bun.write(join(workdir, "file.txt"), "hello\n");
        await git(["add", "file.txt"], workdir);
        await git(["commit", "-m", "Implement #1: task"], workdir);
        await git(["remote", "add", "origin", bare], workdir);
        // Local push (file remote, no proxy involved) still works with the
        // proxy GIT_CONFIG present, and the token never appears.
        await git(["push", "-u", "origin", "jumi/issue-1-task"], workdir);
        expect(JSON.stringify(childEnv)).not.toContain(AUTH.token);
        const head = await git(["rev-parse", "HEAD"], workdir);
        expect(head).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await proxy.close();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("child git proxy access mode", () => {
  test("defaults to read-write, exposes the granted access, and rejects anything else", async () => {
    const def = await startChildGitProxy({
      forgeUrl: AUTH.giteaUrl,
      username: AUTH.username,
      token: AUTH.token,
      owner: "o",
      repo: "r",
    });
    try {
      expect(def.access).toBe("read-write");
    } finally {
      await def.close();
    }
    const explicit = await startChildGitProxy({
      forgeUrl: AUTH.giteaUrl,
      username: AUTH.username,
      token: AUTH.token,
      owner: "o",
      repo: "r",
      access: "read-write",
    });
    try {
      expect(explicit.access).toBe("read-write");
    } finally {
      await explicit.close();
    }
    const ro = await startChildGitProxy({
      forgeUrl: AUTH.giteaUrl,
      username: AUTH.username,
      token: AUTH.token,
      owner: "o",
      repo: "r",
      access: "read-only",
    });
    try {
      expect(ro.access).toBe("read-only");
    } finally {
      await ro.close();
    }
    await expect(
      startChildGitProxy({
        forgeUrl: AUTH.giteaUrl,
        username: AUTH.username,
        token: AUTH.token,
        owner: "o",
        repo: "r",
        access: "bogus" as never,
      })
    ).rejects.toThrow(/access/);
    await expect(
      startChildGitProxy({
        forgeUrl: AUTH.giteaUrl,
        username: AUTH.username,
        token: AUTH.token,
        owner: "o",
        repo: "r",
        access: "" as never,
      })
    ).rejects.toThrow(/access/);
  });

  test("read-write keeps the path-only behavior for every method", () => {
    const allowedPaths = [
      "/o/r.git/info/refs",
      "/o/r.git/HEAD",
      "/o/r.git/git-upload-pack",
      "/o/r.git/git-receive-pack",
      "/o/r.git/objects/info/packs",
      "/o/r.git/objects/ab/cdef0123456789",
      "/o/r/info/refs",
      "/o/r/HEAD",
      "/o/r/git-upload-pack",
      "/o/r/git-receive-pack",
      "/o/r/objects/info/packs",
    ];
    for (const path of allowedPaths) {
      for (const method of ["GET", "HEAD", "POST"]) {
        expect(isGitRequestAllowed(path, "", method, "o", "r", "read-write")).toBe(true);
        expect(isGitRequestAllowed(path, "?service=git-upload-pack", method, "o", "r", "read-write")).toBe(true);
      }
      // The default access is read-write.
      expect(isGitRequestAllowed(path, "", "GET", "o", "r")).toBe(true);
    }
    // Read-write still refuses non-git paths for every method.
    const deniedPaths = [
      "/o/r",
      "/o/r/",
      "/o/r.git",
      "/o/r.git/",
      "/o/r/issues",
      "/o/r/pulls/1",
      "/o/r.git/issues",
      "/api/v1/repos/o/r",
      "/attachments/uuid",
      "/other/r.git/info/refs",
    ];
    for (const path of deniedPaths) {
      for (const method of ["GET", "HEAD", "POST"]) {
        expect(isGitRequestAllowed(path, "", method, "o", "r", "read-write")).toBe(false);
      }
    }
    // Receive-pack stays reachable in read-write, including its advertisement.
    expect(isGitRequestAllowed("/o/r.git/git-receive-pack", "", "POST", "o", "r", "read-write")).toBe(true);
    expect(isGitRequestAllowed("/o/r.git/info/refs", "?service=git-receive-pack", "GET", "o", "r", "read-write")).toBe(
      true
    );
  });

  test("read-only matrix over path x query x method", () => {
    const access: ChildGitProxyAccess = "read-only";
    const cases: Array<[string, string, string, boolean]> = [
      // Upload-pack advertisement: the only allowed info/refs service.
      ["/o/r.git/info/refs", "?service=git-upload-pack", "GET", true],
      ["/o/r.git/info/refs", "?service=git-upload-pack", "HEAD", true],
      ["/o/r.git/info/refs", "", "GET", true],
      ["/o/r.git/info/refs", "", "HEAD", true],
      ["/o/r/info/refs", "?service=git-upload-pack", "GET", true],
      // Receive-pack advertisement is refused, as is any second/ambiguous value.
      ["/o/r.git/info/refs", "?service=git-receive-pack", "GET", false],
      ["/o/r.git/info/refs", "?service=git-receive-pack", "HEAD", false],
      ["/o/r.git/info/refs", "?service=git-upload-pack&service=git-receive-pack", "GET", false],
      ["/o/r.git/info/refs", "?service=git-upload-pack&service=git-upload-pack", "GET", false],
      ["/o/r.git/info/refs", "?service=", "GET", false],
      ["/o/r.git/info/refs", "?service=git-upload-pack", "POST", false],
      ["/o/r.git/info/refs", "", "POST", false],
      ["/o/r.git/info/refs", "?service=git-upload-pack", "PUT", false],
      // Upload-pack: POST only.
      ["/o/r.git/git-upload-pack", "", "POST", true],
      ["/o/r.git/git-upload-pack", "?service=git-upload-pack", "POST", true],
      ["/o/r.git/git-upload-pack", "", "GET", false],
      ["/o/r.git/git-upload-pack", "", "HEAD", false],
      ["/o/r.git/git-upload-pack", "", "PUT", false],
      ["/o/r/git-upload-pack", "", "POST", true],
      ["/o/r/git-upload-pack", "", "GET", false],
      // Receive-pack: refused for every method.
      ["/o/r.git/git-receive-pack", "", "POST", false],
      ["/o/r.git/git-receive-pack", "", "GET", false],
      ["/o/r.git/git-receive-pack", "", "HEAD", false],
      ["/o/r/git-receive-pack", "", "POST", false],
      // HEAD and dumb-HTTP object reads: GET/HEAD only.
      ["/o/r.git/HEAD", "", "GET", true],
      ["/o/r.git/HEAD", "", "HEAD", true],
      ["/o/r.git/HEAD", "", "POST", false],
      ["/o/r/HEAD", "", "GET", true],
      ["/o/r/HEAD", "", "POST", false],
      ["/o/r.git/objects/info/packs", "", "GET", true],
      ["/o/r.git/objects/info/packs", "", "HEAD", true],
      ["/o/r.git/objects/info/packs", "", "POST", false],
      ["/o/r.git/objects/ab/cdef0123456789", "", "GET", true],
      ["/o/r.git/objects/ab/cdef0123456789", "", "POST", false],
      // Everything else stays denied.
      ["/o/r", "", "GET", false],
      ["/o/r.git/", "", "GET", false],
      ["/o/r/issues", "", "GET", false],
      ["/api/v1/repos/o/r", "", "GET", false],
      ["/attachments/uuid", "", "GET", false],
      ["/other/r.git/info/refs", "?service=git-upload-pack", "GET", false],
    ];
    for (const [path, search, method, expected] of cases) {
      expect(isGitRequestAllowed(path, search, method, "o", "r", access)).toBe(expected);
    }
    // Unscoped read-only serves nothing.
    expect(
      isGitRequestAllowed("/o/r.git/info/refs", "?service=git-upload-pack", "GET", undefined, undefined, access)
    ).toBe(false);
  });

  test("read-only proxy refuses push endpoints without contacting upstream or sending the credential", async () => {
    type Seen = { method: string; path: string; search: string; auth: string };
    const seen: Seen[] = [];
    const expectedAuth = `Basic ${Buffer.from(`${AUTH.username}:${AUTH.token}`).toString("base64")}`;
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        seen.push({ method: req.method, path: url.pathname, search: url.search, auth });
        if (auth !== expectedAuth) return new Response("unauthorized", { status: 401 });
        return new Response("git-ok", { status: 200 });
      },
    });
    const forgeBase = `http://127.0.0.1:${forge.port}/`;
    try {
      const proxy = await startChildGitProxy({
        forgeUrl: forgeBase,
        username: AUTH.username,
        token: AUTH.token,
        owner: "o",
        repo: "r",
        access: "read-only",
      });
      try {
        expect(proxy.access).toBe("read-only");
        // Allowed reads are forwarded with the credential.
        const adv = await fetch(`${proxy.url}o/r.git/info/refs?service=git-upload-pack`);
        expect(adv.status).toBe(200);
        expect(await adv.text()).toBe("git-ok");
        expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/o/r.git/info/refs" });
        expect(seen.at(-1)?.auth).toBe(expectedAuth);

        const upload = await fetch(`${proxy.url}o/r.git/git-upload-pack`, { method: "POST", body: "want" });
        expect(upload.status).toBe(200);
        expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/o/r.git/git-upload-pack" });
        expect(seen.at(-1)?.auth).toBe(expectedAuth);

        const head = await fetch(`${proxy.url}o/r.git/HEAD`);
        expect(head.status).toBe(200);
        const hitsAfterAllowed = seen.length;

        // Denied combinations return 404 and never reach upstream.
        const denied: Array<[string, RequestInit?]> = [
          ["o/r.git/info/refs?service=git-receive-pack"],
          ["o/r.git/info/refs?service=git-upload-pack&service=git-receive-pack"],
          ["o/r.git/info/refs", { method: "POST" }],
          ["o/r.git/git-receive-pack", { method: "POST", body: "push" }],
          ["o/r.git/git-receive-pack"],
          ["o/r.git/git-upload-pack"],
          ["o/r.git/HEAD", { method: "POST", body: "x" }],
          ["o/r.git/objects/info/packs", { method: "POST", body: "x" }],
          ["api/v1/repos/o/r"],
        ];
        for (const [path, init] of denied) {
          const res = await fetch(`${proxy.url}${path}`, init);
          expect(res.status).toBe(404);
          await res.text().catch(() => undefined);
        }
        expect(seen.length).toBe(hitsAfterAllowed);
        expect(seen.every((s) => s.auth === expectedAuth)).toBe(true);
      } finally {
        await proxy.close();
      }
    } finally {
      forge.stop();
    }
  });
});

describe("read-only git fixture over a credential-required upstream", () => {
  async function gitExecPath(): Promise<string> {
    const proc = Bun.spawn(["git", "--exec-path"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error("git --exec-path failed");
    return out.trim();
  }

  function startCredentialedGitUpstream(
    projectRoot: string,
    username: string,
    token: string,
    hits: { count: number }
  ): { base: string; stop(): void } {
    const expected = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if ((req.headers.get("authorization") ?? "") !== expected) {
          return new Response("unauthorized", { status: 401 });
        }
        const body =
          req.method !== "GET" && req.method !== "HEAD" ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          GIT_PROJECT_ROOT: projectRoot,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: username,
          GIT_CONFIG_NOSYSTEM: "1",
        };
        const protocol = req.headers.get("git-protocol");
        if (protocol) env.HTTP_GIT_PROTOCOL = protocol;
        const proc = Bun.spawn(["git", "http-backend"], {
          stdin: body,
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
        const [out, errText, code] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).arrayBuffer(),
          proc.exited,
        ]);
        if (code !== 0) return new Response(Buffer.from(errText).toString(), { status: 500 });
        hits.count += 1;
        const raw = Buffer.from(out);
        const text = raw.toString("binary");
        const split = text.search(/\r?\n\r?\n/);
        if (split === -1) return new Response(raw as unknown as BodyInit, { status: 200 });
        const head = text.slice(0, split);
        const bstart = split + (text.slice(split, split + 4) === "\r\n\r\n" ? 4 : 2);
        const headers = new Headers();
        let status = 200;
        for (const line of head.split(/\r?\n/)) {
          const m = line.match(/^([^:]+):\s*(.*)$/);
          if (!m) continue;
          if (m[1].toLowerCase() === "status") {
            status = Number.parseInt(m[2].slice(0, 3), 10) || 200;
            continue;
          }
          headers.set(m[1], m[2]);
        }
        return new Response(raw.subarray(bstart) as unknown as BodyInit, { status, headers });
      },
    });
    return { base: `http://127.0.0.1:${server.port}/`, stop: () => server.stop() };
  }

  test("clone/fetch succeed read-only with the credential; push fails without moving refs; read-write push succeeds", async () => {
    await gitExecPath();
    const root = await mkdtemp(join(tmpdir(), "jumi-git-http-root-"));
    const seed = await mkdtemp(join(tmpdir(), "jumi-git-http-seed-"));
    const hits = { count: 0 };
    const upstream = startCredentialedGitUpstream(root, AUTH.username, AUTH.token, hits);
    try {
      const plainEnv: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? seed,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "jumi",
        GIT_AUTHOR_EMAIL: "jumi@example.com",
        GIT_COMMITTER_NAME: "jumi",
        GIT_COMMITTER_EMAIL: "jumi@example.com",
      };
      const seedGit = async (args: string[], cwd: string) => {
        const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: plainEnv });
        const [out, errText, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${errText}`);
        return out.trim();
      };
      await Bun.spawn(["mkdir", "-p", join(root, "o")]).exited;
      await seedGit(["init", "--bare", "-b", "main", join(root, "o", "r.git")], seed);
      await seedGit(["init", "-b", "main", "work"], seed);
      const seedWork = join(seed, "work");
      await Bun.write(join(seedWork, "file.txt"), "hello\n");
      await seedGit(["add", "file.txt"], seedWork);
      await seedGit(["commit", "-m", "seed"], seedWork);
      await seedGit(["remote", "add", "origin", join(root, "o", "r.git")], seedWork);
      await seedGit(["push", "-u", "origin", "main"], seedWork);
      const revParse = async () => {
        const proc = Bun.spawn(["git", "--git-dir", join(root, "o", "r.git"), "rev-parse", "refs/heads/main"], {
          stdout: "pipe",
          stderr: "pipe",
          env: plainEnv,
        });
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (code !== 0) throw new Error("rev-parse failed");
        return out.trim();
      };

      const runChildGit = (childEnv: Record<string, string>) => {
        return async (args: string[], cwd: string) => {
          const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: childEnv });
          const [out, errText, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { out: out.trim(), err: errText, code };
        };
      };
      const childEnvFor = async (access: ChildGitProxyAccess) => {
        const proxy = await startChildGitProxy({
          forgeUrl: upstream.base,
          username: AUTH.username,
          token: AUTH.token,
          owner: "o",
          repo: "r",
          access,
        });
        const proxyEnv = childProxyGitConfigEnv(proxy.url, {
          forgeUrl: upstream.base,
          forgeHost: new URL(upstream.base).host,
        });
        const childEnv: Record<string, string> = { ...plainEnv, ...proxyEnv };
        return { proxy, childEnv };
      };

      // Read-only: clone and fetch succeed against the credential-required upstream.
      {
        const { proxy, childEnv } = await childEnvFor("read-only");
        try {
          expect(proxy.access).toBe("read-only");
          const git = runChildGit(childEnv);
          const work = await mkdtemp(join(tmpdir(), "jumi-git-ro-"));
          try {
            const clone = await git(["clone", `${upstream.base}o/r.git`, "c"], work);
            expect(clone.code).toBe(0);
            const log = await git(["log", "--oneline", "-1"], join(work, "c"));
            expect(log.code).toBe(0);
            expect(log.out).toContain("seed");
            const fetchRes = await git(["fetch", "origin"], join(work, "c"));
            expect(fetchRes.code).toBe(0);
            expect(JSON.stringify(childEnv)).not.toContain(AUTH.token);

            // Push fails through the read-only proxy and the upstream ref does not move.
            const before = await revParse();
            await Bun.write(join(work, "c", "ro.txt"), "read-only\n");
            await git(["add", "ro.txt"], join(work, "c"));
            await git(["commit", "-m", "read-only change"], join(work, "c"));
            const pushHits = hits.count;
            const push = await git(["push", "origin", "main"], join(work, "c"));
            expect(push.code).not.toBe(0);
            expect(await revParse()).toBe(before);
            // The refused push never reached the credential-required upstream.
            expect(hits.count).toBe(pushHits);
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        } finally {
          await proxy.close();
        }
      }

      // Read-write: the same push still succeeds and moves the ref.
      {
        const { proxy, childEnv } = await childEnvFor("read-write");
        try {
          const git = runChildGit(childEnv);
          const work = await mkdtemp(join(tmpdir(), "jumi-git-rw-"));
          try {
            const clone = await git(["clone", `${upstream.base}o/r.git`, "c"], work);
            expect(clone.code).toBe(0);
            const before = await revParse();
            await Bun.write(join(work, "c", "rw.txt"), "read-write\n");
            await git(["add", "rw.txt"], join(work, "c"));
            await git(["commit", "-m", "read-write change"], join(work, "c"));
            const push = await git(["push", "origin", "main"], join(work, "c"));
            expect(push.code).toBe(0);
            expect(await revParse()).not.toBe(before);
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        } finally {
          await proxy.close();
        }
      }
    } finally {
      upstream.stop();
      await rm(root, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
    }
  });
});
