import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_DENY_DOMAIN, forgeDenyHost, forgePermissions, forgeWebfetchPermission } from "../src/forge_webfetch.ts";
import { IMPLEMENT_PROMPT } from "../src/implement.ts";

interface OpenCodeImplementConfig {
  skills?: { paths?: string[] };
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    edit: "allow" | "ask" | "deny";
    write: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    skill: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    todowrite: "allow" | "ask" | "deny";
    question: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    webfetch: "allow" | "ask" | "deny";
    lsp: "allow" | "ask" | "deny";
  };
}

function bashPermission(rules: Record<string, "allow" | "ask" | "deny">, command: string): "allow" | "ask" | "deny" {
  const normalized = command.replaceAll("\\", "/");
  let decision: "allow" | "ask" | "deny" = "ask";
  for (const [pattern, action] of Object.entries(rules)) {
    let escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    if (new RegExp(`^${escaped}$`, "s").test(normalized)) decision = action;
  }
  return decision;
}

describe("opencode implement config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-implement.json"), "utf8")
  ) as OpenCodeImplementConfig;

  test("allows skills, tasks, and edits for the implement worker", () => {
    expect(config.skills?.paths).toEqual(["/app/review-skills"]);
    expect(config.permission.skill).toBe("allow");
    expect(config.permission.task).toBe("allow");
    expect(config.permission.todowrite).toBe("allow");
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.write).toBe("allow");
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.lsp).toBe("allow");
    expect(config.permission.question).toBe("deny");
  });

  test("denies webfetch of the forge host for the worker, not just the reviewer", () => {
    // The JSON field stays scalar allow (OpenCode types webfetch as Action);
    // the last-match object arrives via OPENCODE_PERMISSION on every spawn,
    // and as `permissions` via OPENCODE_CONFIG_CONTENT for OpenCode 2.
    const rules = forgeWebfetchPermission(FORGE_DENY_DOMAIN);
    expect(Object.keys(rules)).toEqual(["*", `*${FORGE_DENY_DOMAIN}*`, "*github.com/search*"]);

    expect(bashPermission(rules, `https://gitea.${FORGE_DENY_DOMAIN}/personal/jumi/issues/79`)).toBe("deny");
    expect(bashPermission(rules, `https://gitea.${FORGE_DENY_DOMAIN}/api/v1/repos/personal/jumi/pulls`)).toBe("deny");
    expect(bashPermission(rules, `http://gitea.${FORGE_DENY_DOMAIN}/personal/jumi/actions`)).toBe("deny");
    expect(bashPermission(rules, `https://${FORGE_DENY_DOMAIN}/swagger`)).toBe("deny");
    expect(bashPermission(rules, "https://github.com/search?q=foo")).toBe("deny");

    expect(bashPermission(rules, "https://docs.gitea.com/installation")).toBe("allow");
    expect(bashPermission(rules, "https://bun.sh/docs/cli/test")).toBe("allow");

    const v2 = forgePermissions(FORGE_DENY_DOMAIN);
    expect(v2).toEqual([
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "webfetch", resource: `*${FORGE_DENY_DOMAIN}*`, effect: "deny" },
      { action: "webfetch", resource: "*github.com/search*", effect: "deny" },
    ]);
  });

  test("denies the configured forge host, not a compile-time one", () => {
    // The GitHub factory hands the child GIT_AUTH_HOST=github.com plus a
    // write-capable token, so the deny follows the spawn, not the default.
    expect(forgeDenyHost({ GIT_AUTH_HOST: "github.com" })).toBe("github.com");
    expect(forgeDenyHost({ GIT_AUTH_HOST: "gitea.example.com:3000" })).toBe("gitea.example.com");
    expect(forgeDenyHost({})).toBe(FORGE_DENY_DOMAIN);
    expect(forgeDenyHost(undefined)).toBe(FORGE_DENY_DOMAIN);

    const rules = forgeWebfetchPermission(forgeDenyHost({ GIT_AUTH_HOST: "github.com" }));
    expect(bashPermission(rules, "https://github.com/kirmanak/jumi/issues/79")).toBe("deny");
    expect(bashPermission(rules, "https://github.com/kirmanak/jumi/pulls")).toBe("deny");
    expect(bashPermission(rules, "https://github.com/kirmanak/jumi/actions")).toBe("deny");
    expect(bashPermission(rules, "https://api.github.com/repos/kirmanak/jumi/pulls/111")).toBe("deny");
    expect(bashPermission(rules, "https://bun.sh/docs/cli/test")).toBe("allow");

    // A ported forge URL is still covered once the port is dropped.
    const ported = forgeWebfetchPermission(forgeDenyHost({ GIT_AUTH_HOST: "gitea.example.com:3000" }));
    expect(bashPermission(ported, "https://gitea.example.com:3000/personal/jumi/issues/1")).toBe("deny");
  });

  test("allows Read of baked review-skills after star deny (last-match)", () => {
    const rules = config.permission.external_directory;
    expect(rules).toEqual({ "*": "deny", "/app/review-skills/**": "allow" });
    if (typeof rules === "string") throw new Error("expected last-match object, not scalar deny");
    expect(Object.keys(rules)).toEqual(["*", "/app/review-skills/**"]);

    expect(bashPermission(rules, "/app/review-skills/gitea-pull-review/*")).toBe("allow");
    expect(bashPermission(rules, "/app/review-skills/gitops-apply-review/*")).toBe("allow");
    expect(bashPermission(rules, "/app/review-skills/*")).toBe("allow");
    expect(bashPermission(rules, "/app/*")).toBe("deny");
    expect(bashPermission(rules, "/app/.gitea/*")).toBe("deny");
    expect(bashPermission(rules, "/etc/*")).toBe("deny");
    expect(bashPermission(rules, "/data/*")).toBe("deny");
  });

  test("defaults bash to allow instead of a git-only cathedral", () => {
    const bash = config.permission.bash;
    expect(bash["*"]).toBe("allow");
    expect(Object.keys(bash)).toEqual(["*"]);
    expect(bashPermission(bash, "git commit -m wip")).toBe("allow");
    expect(bashPermission(bash, "git push -u origin HEAD")).toBe("allow");
    expect(bashPermission(bash, "bun test")).toBe("allow");
    expect(bashPermission(bash, "rg -n foo | head")).toBe("allow");
  });
});

describe("implement prompt", () => {
  test("commits per logical step, never pushes, forbids force-push and questions", () => {
    expect(IMPLEMENT_PROMPT).toContain("Commit at each coherent logical step");
    expect(IMPLEMENT_PROMPT).toContain("Do not push");
    expect(IMPLEMENT_PROMPT).toContain("The parent pushes once after this run exits");
    expect(IMPLEMENT_PROMPT).not.toContain("push as needed");
    expect(IMPLEMENT_PROMPT).toContain("Do not force-push");
    expect(IMPLEMENT_PROMPT).toContain("Do not amend or rebase commits already on the remote branch");
    expect(IMPLEMENT_PROMPT).toContain("Do not ask questions");
    expect(IMPLEMENT_PROMPT).not.toContain("Do not run git");
    expect(IMPLEMENT_PROMPT).toContain("JUMI_PR.md");
    expect(IMPLEMENT_PROMPT).toContain("JUMI_SKIP.md");
    expect(IMPLEMENT_PROMPT).toContain("Do not open the pull request");
    expect(IMPLEMENT_PROMPT).toContain("Stay in this clone");
    expect(IMPLEMENT_PROMPT).toContain("Do not webfetch this Gitea host");
    expect(IMPLEMENT_PROMPT).toContain("Do not call tea or the forge API");
  });
});
