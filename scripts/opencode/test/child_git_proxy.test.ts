import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childProxyGitConfigEnv,
  childProxyRequestFrom,
  extraEnvHasGitToken,
  isChildStrippedKey,
  isGitPathAllowed,
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
            TMPDIR: join(workdir, ".jumi-tmp"),
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
