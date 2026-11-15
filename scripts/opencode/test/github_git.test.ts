import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import { GithubAPI } from "../src/github_api.ts";
import { implementIssue } from "../src/implement.ts";
import { type GitAuth, type GitRunner, gitAuthResolverFor } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeIssueJob, makePR } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function gitApi(overrides: Partial<IssueApi> = {}): IssueApi {
  return makeIssueApi({
    createPullRequest: async (_owner, _repo, pull) =>
      makePR({
        number: 3,
        title: pull.title,
        body: pull.body,
        html_url: "https://github.com/kirmanak/jumi/pull/3",
      }),
    ...overrides,
  });
}

describe("GitHub git clone/push", () => {
  test("mints installation token before clone and push, embeds x-access-token, and uses bot identity", async () => {
    await withDirs(async (home, workdir) => {
      const tokens = ["ghs_clone", "ghs_push", "ghs_checkpoint_delete"];
      const auths: GitAuth[] = [];
      const logs: string[] = [];
      const gitCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const gitRunner: GitRunner = async (args, opts) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push({ args: gitArgs, env: opts.env });
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      let extraEnv: Record<string, string> | undefined;

      const result = await implementIssue({
        api: gitApi(),
        job: makeIssueJob({
          cloneUrl: "https://github.com/kirmanak/jumi.git",
          htmlUrl: "https://github.com/kirmanak/jumi/issues/12",
        }),
        giteaUrl: "https://github.com",
        giteaToken: "",
        botUsername: "jumi",
        gitAuthResolver: async () => {
          const token = tokens[auths.length] ?? "ghs_extra";
          const auth: GitAuth = {
            giteaUrl: "https://github.com",
            username: "x-access-token",
            token,
            embedTokenInUrl: true,
            authorName: "kirmanak-jumi[bot]",
            authorEmail: "198765+kirmanak-jumi[bot]@users.noreply.github.com",
          };
          auths.push(auth);
          return auth;
        },
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          extraEnv = opts.extraEnv;
          return { status: "ok" };
        },
        logger: (message) => logs.push(message),
      });

      expect(result.status).toBe("pr");
      expect(auths).toHaveLength(3);
      expect(auths[0]?.token).toBe("ghs_clone");
      expect(auths[1]?.token).toBe("ghs_push");
      expect(auths[2]?.token).toBe("ghs_checkpoint_delete");
      const clone = gitCalls.find((call) => call.args[0] === "clone");
      expect(clone?.args).toEqual([
        "clone",
        "--bare",
        "https://x-access-token:ghs_clone@github.com/kirmanak/jumi.git",
        join(workdir, "_cache/kirmanak/demo.git"),
      ]);
      expect(gitCalls.some((call) => call.args[0] === "remote" && call.args[1] === "set-url")).toBe(true);
      const push = gitCalls.find((call) => call.args[0] === "push");
      expect(push?.args).toEqual(["push", "-u", "origin", "jumi/issue-12-fix-the-thing"]);
      expect(push?.env.GIT_AUTH_TOKEN).toBe("ghs_push");
      const checkpointDelete = gitCalls.find((call) => call.args[0] === "push" && call.args[2] === ":refs/jumi/wip/12");
      expect(checkpointDelete?.args).toEqual(["push", "origin", ":refs/jumi/wip/12"]);
      expect(checkpointDelete?.env.GIT_AUTH_TOKEN).toBe("ghs_checkpoint_delete");
      const commit = gitCalls.find((call) => call.args[0] === "commit");
      expect(commit?.env.GIT_AUTHOR_NAME).toBe("kirmanak-jumi[bot]");
      expect(commit?.env.GIT_AUTHOR_EMAIL).toBe("198765+kirmanak-jumi[bot]@users.noreply.github.com");
      expect(commit?.env.GIT_COMMITTER_NAME).toBe("kirmanak-jumi[bot]");
      expect(commit?.env.GIT_COMMITTER_EMAIL).toBe("198765+kirmanak-jumi[bot]@users.noreply.github.com");
      expect(extraEnv?.GIT_AUTH_USERNAME).toBe("x-access-token");
      expect(extraEnv?.GIT_AUTH_TOKEN).toBe("ghs_clone");
      expect(extraEnv?.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      expect(logs.join("\n")).not.toContain("ghs_clone");
      expect(logs.join("\n")).not.toContain("ghs_push");
      expect(logs.join("\n")).not.toContain("ghs_checkpoint_delete");
      expect(extraEnv).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
    });
  });

  test("gitAuthResolverFor uses GithubAPI credentials and leaves Gitea APIs on the bot token", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        if (String(url).includes("/graphql")) {
          return Response.json({ data: { viewer: { login: "kirmanak-jumi[bot]", databaseId: 7 } } });
        }
        return Response.json({});
      }) as unknown as typeof fetch;
      const github = new GithubAPI({
        auth: {
          getInstallationToken: async () => "ghs_cached",
          refreshInstallationToken: async () => "ghs_minted",
        },
      });
      const githubAuth = await gitAuthResolverFor(
        { giteaUrl: "https://github.com", giteaToken: "", botUsername: "jumi" },
        github
      )();
      expect(githubAuth).toEqual({
        giteaUrl: "https://github.com",
        username: "x-access-token",
        token: "ghs_minted",
        embedTokenInUrl: true,
        authorName: "kirmanak-jumi[bot]",
        authorEmail: "7+kirmanak-jumi[bot]@users.noreply.github.com",
      });

      const giteaAuth = await gitAuthResolverFor(
        { giteaUrl: "https://gitea.kirmanak.stream", giteaToken: "bot-token", botUsername: "jumi" },
        gitApi()
      )();
      expect(giteaAuth).toEqual({
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
