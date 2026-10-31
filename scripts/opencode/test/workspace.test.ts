import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  checkoutPullRequestWorkspace,
  createReviewWorkspace,
  GITHUB_GIT_USERNAME,
  type GitRunner,
  gitConfigArgs,
  redactGitSecrets,
  removeReviewWorkspace,
  reviewMirrorPath,
  runGit,
  validateCloneUrl,
  workerOpenCodeChildEnv,
} from "../src/workspace.ts";
import { makeBranch, makeJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

function makeCheckoutFixture() {
  const repo = makeRepo({
    name: "housing_app",
    full_name: "personal/housing_app",
    clone_url: "https://gitea.kirmanak.stream/personal/housing_app.git",
    owner: makeUser({ login: "personal" }),
  });
  const pr = makePR({
    number: 48,
    head: makeBranch({ ref: "feature/release", sha: "a".repeat(40), repo }),
    base: makeBranch({ ref: "main", sha: "b".repeat(40), repo }),
  });
  return { repo, pr };
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

async function markBareMirror(path: string): Promise<void> {
  await mkdir(join(path, "objects"), { recursive: true });
  await mkdir(join(path, "refs"), { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), "[core]\n\tbare = true\n");
}

async function stageBareClone(args: string[]): Promise<void> {
  const gitArgs = stripGitConfigArgs(args);
  if (gitArgs[0] === "clone" && gitArgs[1] === "--bare") await markBareMirror(gitArgs.at(-1) ?? "");
}

function gitConfigValues(args: string[], key: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") continue;
    const config = args[index + 1];
    const prefix = `${key}=`;
    if (config.startsWith(prefix)) values.push(config.slice(prefix.length));
    index += 1;
  }
  return values;
}

describe("clone URL origin allowlist", () => {
  test("accepts github.com when forge URL is github.com and rejects a Gitea clone URL", () => {
    expect(validateCloneUrl("https://github.com/kirmanak/jumi.git", "https://github.com")).toBe(
      "https://github.com/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", "https://github.com")).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
  });

  test("accepts Gitea when forge URL is Gitea and rejects github.com", () => {
    expect(validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", "https://gitea.kirmanak.stream")).toBe(
      "https://gitea.kirmanak.stream/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://github.com/kirmanak/jumi.git", "https://gitea.kirmanak.stream")).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
  });
});

describe("redactGitSecrets", () => {
  test("redacts URL passwords and explicit tokens", () => {
    expect(redactGitSecrets("https://x-access-token:ghs_secret@github.com/kirmanak/jumi.git", ["ghs_secret"])).toBe(
      "https://x-access-token:***@github.com/kirmanak/jumi.git"
    );
    expect(redactGitSecrets("token=ghs_secret in stderr", ["ghs_secret"])).toBe("token=*** in stderr");
  });

  test("redacts the credential-helper command, not only the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-redact-"));
    try {
      // GIT_DIR pins git to a repository that does not exist, so the command fails wherever tmpdir lives.
      const failure = await runGit([...gitConfigArgs(), "fetch", "origin"], {
        cwd: dir,
        env: { PATH: process.env.PATH, GIT_DIR: join(dir, "missing.git"), GIT_AUTH_TOKEN: "ghs_secret" },
      }).then(
        () => "",
        (err: Error) => err.message
      );
      expect(failure).toContain("credential.helper=***");
      expect(failure).not.toContain("GIT_AUTH_TOKEN");
      expect(failure).not.toContain("!f()");
      const comment = redactGitSecrets(`Jumi failed: git -c credential.helper=${gitConfigArgs()[3]} fetch`);
      expect(comment).not.toContain("GIT_AUTH_TOKEN");
      expect(comment).not.toContain("printf");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("review workspace", () => {
  test("creates a unique empty workspace under the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-workspace-test-"));
    try {
      const workspace = await createReviewWorkspace(
        root,
        makeJob({ owner: "personal", repo: "housing_app", prNumber: 48 })
      );
      expect(workspace.startsWith(join(root, "jumi-personal-housing_app-48-"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clones the base repository, fetches target and PR refs, and checks out PR head", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      const url = "https://gitea.kirmanak.stream/personal/housing_app.git";
      const calls: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
      const gitRunner: GitRunner = async (args, opts) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push({ args, cwd: opts.cwd, env: opts.env });
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls.map((call) => stripGitConfigArgs(call.args))).toEqual([
        ["clone", "--bare", url, `${mirror}.incoming`],
        ["config", "gc.auto", "0"],
        ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
        ["clone", "--reference", mirror, url, workdir],
        ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        ["branch", "--force", "jumi/target", "b".repeat(40)],
        ["fetch", "origin", "+refs/pull/48/head:refs/remotes/origin/pr/48/head"],
        ["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)],
        ["rev-parse", "HEAD"],
        ["rev-parse", "jumi/target"],
      ]);
      expect(mirror).toBe(join(root, "_review-mirrors", "personal", "housing_app.git"));
      expect(calls[0].cwd).toBe(dirname(mirror));
      expect(calls[2].cwd).toBe(mirror);
      expect(calls[3].cwd).toBe(root);
      expect(gitConfigValues(calls[0].args, "gc.auto")).toEqual(["0"]);
      expect(gitConfigValues(calls[2].args, "gc.auto")).toEqual(["0"]);
      expect(calls.some((call) => call.args.includes("--depth") || call.args.includes("--shared"))).toBe(false);
      expect(calls.some((call) => `${call.cwd} ${call.args.join(" ")}`.includes(`${sep}_cache${sep}`))).toBe(false);
      expect(calls[0].env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[0].env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[0].env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[0].env.GIT_LFS_SKIP_SMUDGE).toBe("1");
      expect(calls[0].env.GIT_AUTHOR_NAME).toBe("jumi");
      expect(calls[0].env.GIT_AUTHOR_EMAIL).toBe("jumi@kirmanak.stream");
      expect(calls[0].env.GIT_COMMITTER_NAME).toBe("jumi");
      expect(calls[0].env.GIT_COMMITTER_EMAIL).toBe("jumi@kirmanak.stream");
      expect(calls[0].env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(calls[0].env.GIT_AUTH_USERNAME).toBe("jumi");
      expect(calls[0].env.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(calls[0].env.GIT_AUTH_HOST).toBe("gitea.kirmanak.stream");
      expect(gitConfigValues(calls[0].args, "core.hooksPath")).toEqual(["/dev/null"]);
      expect(gitConfigValues(calls[0].args, "core.symlinks")).toEqual(["false"]);
      expect(gitConfigValues(calls[0].args, "credential.helper")).toContain("");
      expect(
        gitConfigValues(calls[0].args, "credential.helper").some((helper) => helper.includes("GIT_AUTH_TOKEN"))
      ).toBe(true);
      expect(gitConfigValues(calls[0].args, "credential.helper").join("\n")).not.toContain("bot-token");
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("bot-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses an existing review mirror instead of cloning it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      await markBareMirror(mirror);
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        calls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls[0]).toEqual(["config", "gc.auto", "0"]);
      expect(calls[1]).toEqual(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
      expect(calls.some((args) => args[0] === "clone" && args[1] === "--bare")).toBe(false);
      expect(calls[2]).toEqual([
        "clone",
        "--reference",
        mirror,
        "https://gitea.kirmanak.stream/personal/housing_app.git",
        workdir,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a symlinked mirror instead of fetching through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      const elsewhere = join(root, "elsewhere.git");
      await mkdir(elsewhere, { recursive: true });
      await mkdir(dirname(mirror), { recursive: true });
      await symlink(elsewhere, mirror);
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls[0]?.slice(0, 2)).toEqual(["clone", "--bare"]);
      expect(calls[0]?.at(-1)).toBe(`${mirror}.incoming`);
      expect((await lstat(mirror)).isDirectory()).toBe(true);
      expect((await lstat(mirror)).isSymbolicLink()).toBe(false);
      expect((await lstat(elsewhere)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclones when the mirror directory is not a bare repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      await mkdir(mirror, { recursive: true });
      await writeFile(join(mirror, "LEFTOVER"), "partial");
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls[0]?.slice(0, 2)).toEqual(["clone", "--bare"]);
      expect(calls[0]?.at(-1)).toBe(`${mirror}.incoming`);
      expect(await readFile(join(mirror, "HEAD"), "utf8")).toContain("ref:");
      await expect(readFile(join(mirror, "LEFTOVER"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a symlinked owner directory instead of borrowing the cache behind it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      const cacheOwner = join(root, "_cache", "personal");
      await mkdir(join(root, "_review-mirrors"), { recursive: true });
      await markBareMirror(join(cacheOwner, "housing_app.git"));
      await writeFile(join(cacheOwner, "KEEP"), "cache");
      await symlink(cacheOwner, dirname(mirror));
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls[0]?.slice(0, 2)).toEqual(["clone", "--bare"]);
      expect(calls.some((args) => args.join(" ").includes(`${sep}_cache${sep}`))).toBe(false);
      expect((await lstat(dirname(mirror))).isSymbolicLink()).toBe(false);
      expect(await realpath(dirname(mirror))).not.toBe(await realpath(cacheOwner));
      expect(await readFile(join(cacheOwner, "KEEP"), "utf8")).toBe("cache");
      expect(await readFile(join(cacheOwner, "housing_app.git", "config"), "utf8")).toContain("bare = true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a symlinked mirror root instead of borrowing the cache behind it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      const cacheRoot = join(root, "_cache");
      await markBareMirror(join(cacheRoot, "personal", "housing_app.git"));
      await writeFile(join(cacheRoot, "KEEP"), "cache");
      await symlink(cacheRoot, join(root, "_review-mirrors"));
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls[0]?.slice(0, 2)).toEqual(["clone", "--bare"]);
      expect(calls[0]?.at(-1)).toBe(`${mirror}.incoming`);
      expect(calls.some((args) => args.join(" ").includes(`${sep}_cache${sep}`))).toBe(false);
      expect((await lstat(join(root, "_review-mirrors"))).isSymbolicLink()).toBe(false);
      expect(await realpath(join(root, "_review-mirrors"))).not.toBe(await realpath(cacheRoot));
      expect(await readFile(join(cacheRoot, "KEEP"), "utf8")).toBe("cache");
      expect(await readFile(join(cacheRoot, "personal", "housing_app.git", "config"), "utf8")).toContain("bare = true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes mirror updates for one repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      let releaseFirst: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirst: () => void = () => {};
      const firstFetchEntered = new Promise<void>((resolve) => {
        markFirst = resolve;
      });
      let fetches = 0;
      let bareClones = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "clone" && gitArgs[1] === "--bare") {
          bareClones += 1;
          await markBareMirror(gitArgs.at(-1) ?? "");
        }
        if (gitArgs[0] === "fetch" && gitArgs[2] === "+refs/heads/*:refs/remotes/origin/*") {
          fetches += 1;
          if (fetches === 1) {
            markFirst();
            await hold;
          }
        }
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };
      const opts = {
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      };
      const first = checkoutPullRequestWorkspace(opts);
      const second = checkoutPullRequestWorkspace(opts);
      await firstFetchEntered;
      expect(fetches).toBe(1);
      expect(bareClones).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(fetches).toBe(2);
      expect(bareClones).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an owner or repo that would escape the mirror directory", async () => {
    const { pr } = makeCheckoutFixture();
    const calls: string[][] = [];
    const gitRunner: GitRunner = async (args) => {
      calls.push(args);
      return "";
    };
    const escaped = makeRepo({
      name: "housing_app",
      full_name: "personal/housing_app",
      clone_url: "https://gitea.kirmanak.stream/personal/housing_app.git",
      owner: makeUser({ login: "../personal" }),
    });
    await expect(
      checkoutPullRequestWorkspace({
        workdir: join(tmpdir(), "review-48"),
        repo: escaped,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      })
    ).rejects.toThrow("Invalid owner");
    expect(calls).toHaveLength(0);
  });

  test("falls back to the source repository when the base repository lacks the PR ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const { repo, pr } = makeCheckoutFixture();
      const calls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push(args);
        if (gitArgs[0] === "fetch" && gitArgs[1] === "origin" && gitArgs[2].startsWith("+refs/pull/")) {
          throw new Error("missing pull ref");
        }
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });

      expect(calls.map(stripGitConfigArgs)).toContainEqual([
        "clone",
        "--reference",
        reviewMirrorPath(workdir, "personal", "housing_app"),
        "https://gitea.kirmanak.stream/personal/housing_app.git",
        workdir,
      ]);
      expect(calls.map(stripGitConfigArgs)).toContainEqual([
        "remote",
        "add",
        "pr-head",
        "https://gitea.kirmanak.stream/personal/housing_app.git",
      ]);
      expect(calls.map(stripGitConfigArgs)).toContainEqual([
        "fetch",
        "pr-head",
        "+refs/heads/feature/release:refs/remotes/pr-head/feature/release",
      ]);
      expect(calls.map(stripGitConfigArgs)).toContainEqual(["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)]);
      expect(stripGitConfigArgs(calls.at(-2) ?? [])).toEqual(["rev-parse", "HEAD"]);
      expect(stripGitConfigArgs(calls.at(-1) ?? [])).toEqual(["rev-parse", "jumi/target"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clones GitHub with x-access-token URL and does not log the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-ws-"));
    try {
      const workdir = join(root, "review-48");
      const repo = makeRepo({
        name: "jumi",
        full_name: "kirmanak/jumi",
        clone_url: "https://github.com/kirmanak/jumi.git",
        owner: makeUser({ login: "kirmanak" }),
      });
      const pr = makePR({
        number: 48,
        head: makeBranch({ ref: "feature/release", sha: "a".repeat(40), repo }),
        base: makeBranch({ ref: "main", sha: "b".repeat(40), repo }),
      });
      const mirror = reviewMirrorPath(workdir, "kirmanak", "jumi");
      const clean = "https://github.com/kirmanak/jumi.git";
      const tokenUrl = "https://x-access-token:ghs_install@github.com/kirmanak/jumi.git";
      const logs: string[] = [];
      const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const gitRunner: GitRunner = async (args, opts) => {
        await stageBareClone(args);
        const gitArgs = stripGitConfigArgs(args);
        calls.push({ args, env: opts.env });
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
        return "";
      };

      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: "https://github.com",
        username: GITHUB_GIT_USERNAME,
        token: "ghs_install",
        embedTokenInUrl: true,
        authorName: "kirmanak-jumi[bot]",
        authorEmail: "123+kirmanak-jumi[bot]@users.noreply.github.com",
        gitRunner,
        logger: (message) => logs.push(message),
      });

      expect(calls.map((call) => stripGitConfigArgs(call.args))).toEqual([
        ["clone", "--bare", tokenUrl, `${mirror}.incoming`],
        ["remote", "set-url", "origin", clean],
        ["config", "gc.auto", "0"],
        ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
        ["clone", "--reference", mirror, tokenUrl, workdir],
        ["remote", "set-url", "origin", clean],
        ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        ["branch", "--force", "jumi/target", "b".repeat(40)],
        ["fetch", "origin", "+refs/pull/48/head:refs/remotes/origin/pr/48/head"],
        ["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)],
        ["rev-parse", "HEAD"],
        ["rev-parse", "jumi/target"],
      ]);
      expect(mirror).not.toContain("ghs_install");
      expect(calls[0].env.GIT_AUTH_USERNAME).toBe("x-access-token");
      expect(calls[0].env.GIT_AUTH_TOKEN).toBe("ghs_install");
      expect(calls[0].env.GIT_AUTHOR_NAME).toBe("kirmanak-jumi[bot]");
      expect(calls[0].env.GIT_AUTHOR_EMAIL).toBe("123+kirmanak-jumi[bot]@users.noreply.github.com");
      expect(calls[0].env.GIT_COMMITTER_NAME).toBe("kirmanak-jumi[bot]");
      expect(calls[0].env.GIT_COMMITTER_EMAIL).toBe("123+kirmanak-jumi[bot]@users.noreply.github.com");
      expect(logs.join("\n")).not.toContain("ghs_install");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function seedGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function seedServedRepo(originRoot: string): Promise<{ base: string; head: string }> {
  const src = join(originRoot, "src");
  await mkdir(src, { recursive: true });
  seedGit(src, ["init", "-q", "-b", "main"]);
  await writeFile(join(src, "README.md"), "a\n");
  seedGit(src, ["add", "README.md"]);
  seedGit(src, ["commit", "-qm", "base-commit"]);
  const base = seedGit(src, ["rev-parse", "HEAD"]);
  await writeFile(join(src, "README.md"), "b\n");
  seedGit(src, ["commit", "-qam", "head-commit"]);
  const head = seedGit(src, ["rev-parse", "HEAD"]);
  const bare = join(originRoot, "personal", "housing_app.git");
  await mkdir(dirname(bare), { recursive: true });
  seedGit(originRoot, ["clone", "--bare", src, bare]);
  seedGit(bare, ["update-ref", "refs/heads/main", base]);
  seedGit(bare, ["update-ref", "refs/pull/48/head", head]);
  seedGit(bare, ["update-server-info"]);
  return { base, head };
}

function startOrigin(originRoot: string): { port: number; stop: () => void } {
  const root = resolve(originRoot);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("no", { status: 405 });
      const rel = decodeURIComponent(url.pathname);
      const file = resolve(root, `.${rel}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) return new Response("no", { status: 404 });
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile()) return new Response("missing", { status: 404 });
      const data = await readFile(file);
      const contentType = file.endsWith(".pack")
        ? "application/x-git-packed-objects"
        : file.endsWith(".idx")
          ? "application/x-git-packed-objects-toc"
          : "text/plain";
      return new Response(request.method === "HEAD" ? null : data, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Length": String(data.byteLength) },
      });
    },
  });
  if (!server.port) throw new Error("origin server did not bind a port");
  return { port: server.port, stop: () => server.stop(true) };
}

describe("review mirror checkout", () => {
  test("borrows the mirror for history and keeps a pull-only commit reachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-review-mirror-"));
    const originRoot = join(root, "origin");
    let stop = () => {};
    try {
      const { base, head } = await seedServedRepo(originRoot);
      const server = startOrigin(originRoot);
      stop = server.stop;
      const origin = `http://127.0.0.1:${server.port}`;
      const repo = makeRepo({
        name: "housing_app",
        full_name: "personal/housing_app",
        clone_url: `${origin}/personal/housing_app.git`,
        html_url: `${origin}/personal/housing_app`,
        owner: makeUser({ login: "personal" }),
      });
      const pr = makePR({
        number: 48,
        head: makeBranch({ ref: "feature/release", sha: head, repo }),
        base: makeBranch({ ref: "main", sha: base, repo }),
      });
      const seen: string[][] = [];
      const logs: string[] = [];
      const gitRunner: GitRunner = async (args, opts) => {
        seen.push(stripGitConfigArgs(args));
        return runGit(args, opts);
      };
      const workdir = join(root, "review-a");
      await mkdir(workdir);
      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: `${origin}/`,
        username: "jumi",
        token: "s3cret-token",
        embedTokenInUrl: true,
        gitRunner,
        logger: (message) => logs.push(message),
      });

      const mirror = reviewMirrorPath(workdir, "personal", "housing_app");
      expect(mirror).toBe(join(root, "_review-mirrors", "personal", "housing_app.git"));
      expect(mirror.includes(`${sep}_cache${sep}`)).toBe(false);
      expect(seen.filter((args) => args[0] === "clone" && args[1] === "--bare")).toHaveLength(1);
      const referenced = seen.filter((args) => args[0] === "clone" && args.includes("--reference"));
      expect(referenced).toHaveLength(1);
      expect(referenced[0]?.slice(0, 3)).toEqual(["clone", "--reference", mirror]);
      expect(referenced[0]?.[2]).not.toContain("s3cret-token");
      expect(referenced[0]?.[3]).toContain("s3cret-token");
      expect(referenced[0]?.[4]).toBe(workdir);
      expect(
        seen.some((args) => args.includes("--depth") || args.includes("--filter") || args.includes("--shared"))
      ).toBe(false);
      const alternates = await readFile(join(workdir, ".git", "objects", "info", "alternates"), "utf8");
      expect(await realpath(alternates.trim())).toBe(await realpath(join(mirror, "objects")));
      expect(seedGit(workdir, ["rev-parse", "--is-shallow-repository"])).toBe("false");
      expect(seedGit(workdir, ["merge-base", "--is-ancestor", base, "HEAD"])).toBe("");
      expect(seedGit(workdir, ["log", "--format=%s", `${base}..HEAD`])).toBe("head-commit");
      expect(seedGit(workdir, ["rev-parse", "--git-common-dir"])).not.toContain("_review-mirrors");
      expect(seedGit(mirror, ["config", "--get", "gc.auto"])).toBe("0");
      expect(seedGit(mirror, ["remote", "get-url", "origin"])).toBe(`${origin}/personal/housing_app.git`);
      expect(seedGit(workdir, ["remote", "get-url", "origin"])).toBe(`${origin}/personal/housing_app.git`);
      expect(await readFile(join(mirror, "config"), "utf8")).not.toContain("s3cret-token");
      expect(await readFile(join(workdir, ".git", "config"), "utf8")).not.toContain("s3cret-token");
      expect(logs.join("\n")).not.toContain("s3cret-token");

      const workdir2 = join(root, "review-b");
      await mkdir(workdir2);
      await checkoutPullRequestWorkspace({
        workdir: workdir2,
        repo,
        pr,
        giteaUrl: `${origin}/`,
        username: "jumi",
        token: "s3cret-token",
        embedTokenInUrl: true,
        gitRunner,
        logger: (message) => logs.push(message),
      });
      expect(seen.filter((args) => args[0] === "clone" && args[1] === "--bare")).toHaveLength(1);
      expect(seen.filter((args) => args[0] === "clone" && args.includes("--reference"))).toHaveLength(2);
      expect(seedGit(workdir2, ["log", "--format=%s", `${base}..HEAD`])).toBe("head-commit");
      expect(seedGit(workdir2, ["rev-parse", "HEAD"])).toBe(head);

      await removeReviewWorkspace(workdir);
      expect(await readFile(join(mirror, "HEAD"), "utf8")).toContain("ref:");
      expect(seedGit(workdir2, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workerOpenCodeChildEnv", () => {
  const auth = {
    giteaUrl: "https://gitea.kirmanak.stream",
    username: "jumi",
    token: "bot-token",
  };

  test("passes git auth plus JDK/Gradle env under /work, not HOME", () => {
    const originalJavaHome = process.env.JAVA_HOME;
    const originalWorkdir = process.env.WORKDIR;
    delete process.env.JAVA_HOME;
    delete process.env.WORKDIR;
    try {
      const env = workerOpenCodeChildEnv(auth, "/work/kirmanak/demo/12");
      expect(env.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(env.JAVA_HOME).toBe("/opt/java/openjdk");
      expect(env.PATH.startsWith("/opt/java/openjdk/bin:")).toBe(true);
      expect(env.JAVA_TOOL_OPTIONS).toBe("-Djava.io.tmpdir=/work/kirmanak/demo/12/.jumi-tmp");
      expect(env.GRADLE_USER_HOME).toBe("/work/.gradle");
      expect(env.GRADLE_OPTS).toBe("-Dorg.gradle.daemon=false");
      expect(env.HOME).toBeUndefined();
    } finally {
      if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = originalJavaHome;
      if (originalWorkdir === undefined) delete process.env.WORKDIR;
      else process.env.WORKDIR = originalWorkdir;
    }
  });

  test("forwards image JAVA_HOME and WORKDIR", () => {
    const originalJavaHome = process.env.JAVA_HOME;
    const originalWorkdir = process.env.WORKDIR;
    process.env.JAVA_HOME = "/opt/custom-jdk";
    process.env.WORKDIR = "/work";
    try {
      const env = workerOpenCodeChildEnv(auth, "/work/owner/repo/1");
      expect(env.JAVA_HOME).toBe("/opt/custom-jdk");
      expect(env.PATH.startsWith("/opt/custom-jdk/bin:")).toBe(true);
      expect(env.GRADLE_USER_HOME).toBe("/work/.gradle");
    } finally {
      if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = originalJavaHome;
      if (originalWorkdir === undefined) delete process.env.WORKDIR;
      else process.env.WORKDIR = originalWorkdir;
    }
  });
});
