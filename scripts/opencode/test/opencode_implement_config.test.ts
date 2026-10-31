import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_DENY_DOMAIN, forgeDenyHost, forgePermissions } from "../src/forge_webfetch.ts";
import { IMPLEMENT_PROMPT } from "../src/implement.ts";

type Effect = "allow" | "ask" | "deny";

interface OpenCodeImplementConfig {
  experimental?: { todo?: boolean };
  skills?: string[];
  permissions: { action: string; resource: string; effect: Effect }[];
}

function resourceRules(rules: { resource: string; effect: Effect }[]): Record<string, Effect> {
  return Object.fromEntries(rules.map((rule) => [rule.resource, rule.effect]));
}

function webfetchRules(host: string): Record<string, Effect> {
  return resourceRules(forgePermissions(host));
}

function lastMatch(rules: Record<string, Effect>, command: string): Effect {
  const normalized = command.replaceAll("\\", "/");
  let decision: Effect = "ask";
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
  const rulesFor = (action: string) => resourceRules(config.permissions.filter((rule) => rule.action === action));

  test("allows skills, tasks, and edits for the implement worker", () => {
    expect(config.skills).toEqual(["/app/review-skills", ".claude/skills", ".agents/skills"]);
    expect(rulesFor("skill")).toEqual({ "*": "allow" });
    expect(rulesFor("subagent")).toEqual({ "*": "allow" });
    expect(rulesFor("todowrite")).toEqual({ "*": "allow" });
    expect(rulesFor("edit")).toEqual({ "*": "allow" });
    expect(rulesFor("webfetch")).toEqual({ "*": "allow" });
    expect(rulesFor("question")).toEqual({ "*": "deny" });
  });

  test("keeps the todo tool, which OpenCode 2 turns off unless opted in", () => {
    expect(config.experimental?.todo).toBe(true);
  });

  test("denies webfetch of the forge host for the worker, not just the reviewer", () => {
    // The JSON keeps one star allow; the last-match rules arrive as
    // `permissions` via OPENCODE_CONFIG_CONTENT on every spawn.
    const rules = webfetchRules(FORGE_DENY_DOMAIN);
    expect(Object.keys(rules)).toEqual(["*", `*${FORGE_DENY_DOMAIN}*`, "*github.com/search*"]);

    expect(lastMatch(rules, `https://gitea.${FORGE_DENY_DOMAIN}/personal/jumi/issues/79`)).toBe("deny");
    expect(lastMatch(rules, `https://gitea.${FORGE_DENY_DOMAIN}/api/v1/repos/personal/jumi/pulls`)).toBe("deny");
    expect(lastMatch(rules, `http://gitea.${FORGE_DENY_DOMAIN}/personal/jumi/actions`)).toBe("deny");
    expect(lastMatch(rules, `https://${FORGE_DENY_DOMAIN}/swagger`)).toBe("deny");
    expect(lastMatch(rules, "https://github.com/search?q=foo")).toBe("deny");

    expect(lastMatch(rules, "https://docs.gitea.com/installation")).toBe("allow");
    expect(lastMatch(rules, "https://bun.sh/docs/cli/test")).toBe("allow");

    expect(forgePermissions(FORGE_DENY_DOMAIN)).toEqual([
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

    const rules = webfetchRules(forgeDenyHost({ GIT_AUTH_HOST: "github.com" }));
    expect(lastMatch(rules, "https://github.com/kirmanak/jumi/issues/79")).toBe("deny");
    expect(lastMatch(rules, "https://github.com/kirmanak/jumi/pulls")).toBe("deny");
    expect(lastMatch(rules, "https://github.com/kirmanak/jumi/actions")).toBe("deny");
    expect(lastMatch(rules, "https://api.github.com/repos/kirmanak/jumi/pulls/111")).toBe("deny");
    expect(lastMatch(rules, "https://bun.sh/docs/cli/test")).toBe("allow");

    // A ported forge URL is still covered once the port is dropped.
    const ported = webfetchRules(forgeDenyHost({ GIT_AUTH_HOST: "gitea.example.com:3000" }));
    expect(lastMatch(ported, "https://gitea.example.com:3000/personal/jumi/issues/1")).toBe("deny");
  });

  test("allows Read of baked review-skills after star deny (last-match)", () => {
    const rules = rulesFor("external_directory");
    expect(Object.entries(rules)).toEqual([
      ["*", "deny"],
      ["/app/review-skills/**", "allow"],
    ]);

    expect(lastMatch(rules, "/app/review-skills/gitea-pull-review/*")).toBe("allow");
    expect(lastMatch(rules, "/app/review-skills/gitops-apply-review/*")).toBe("allow");
    expect(lastMatch(rules, "/app/review-skills/*")).toBe("allow");
    expect(lastMatch(rules, "/app/*")).toBe("deny");
    expect(lastMatch(rules, "/app/.gitea/*")).toBe("deny");
    expect(lastMatch(rules, "/etc/*")).toBe("deny");
    expect(lastMatch(rules, "/data/*")).toBe("deny");
  });

  test("defaults shell to allow instead of a git-only cathedral", () => {
    const shell = rulesFor("shell");
    expect(shell).toEqual({ "*": "allow" });
    expect(lastMatch(shell, "git commit -m wip")).toBe("allow");
    expect(lastMatch(shell, "git push -u origin HEAD")).toBe("allow");
    expect(lastMatch(shell, "bun test")).toBe("allow");
    expect(lastMatch(shell, "rg -n foo | head")).toBe("allow");
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
