import { describe, expect, test } from "bun:test";
import { GiteaAPI } from "../src/api.ts";
import { FORGE_CAPABILITIES, forgeCapabilities } from "../src/forge_capabilities.ts";
import { GithubAPI } from "../src/github_api.ts";
import { makeForgeApi } from "./fakes/forge.ts";

describe("forge capabilities table", () => {
  test("gitea row declares gitea semantics", () => {
    const caps = FORGE_CAPABILITIES.gitea;
    expect(caps.kind).toBe("gitea");
    expect(caps.readableAutoMergeSchedule).toBe(false);
    expect(caps.supportsAutoMergeRestore).toBe(false);
    expect(caps.takeoverMarker).toBe("assignee");
    expect(caps.pickupLabelApplies).toBe(false);
    expect(caps.runnerChainsAvailable).toBe(true);
  });

  test("github row declares github semantics", () => {
    const caps = FORGE_CAPABILITIES.github;
    expect(caps.kind).toBe("github");
    expect(caps.readableAutoMergeSchedule).toBe(true);
    expect(caps.supportsAutoMergeRestore).toBe(true);
    expect(caps.takeoverMarker).toBe("label");
    expect(caps.pickupLabelApplies).toBe(true);
    expect(caps.runnerChainsAvailable).toBe(false);
  });

  test("forgeCapabilities defaults to gitea, preserving ?? gitea", () => {
    expect(forgeCapabilities().kind).toBe("gitea");
    expect(forgeCapabilities(undefined).kind).toBe("gitea");
    expect(forgeCapabilities("").kind).toBe("gitea");
    expect(forgeCapabilities("   ").kind).toBe("gitea");
    expect(forgeCapabilities("gitea").kind).toBe("gitea");
    expect(forgeCapabilities("github").kind).toBe("github");
    expect(forgeCapabilities("anything-else").kind).toBe("gitea");
  });
});

describe("adapter capabilities conformance", () => {
  test("adapters expose the table row", () => {
    const gitea = new GiteaAPI("https://gitea.example.test", "token");
    const github = new GithubAPI({ token: "token" });
    expect(gitea.capabilities).toBe(FORGE_CAPABILITIES.gitea);
    expect(github.capabilities).toBe(FORGE_CAPABILITIES.github);
  });

  test("shared forge fake exposes capabilities", () => {
    const fake = makeForgeApi();
    expect(fake.capabilities).toBe(FORGE_CAPABILITIES.gitea);
  });

  test("optional schedule methods exist on both adapters", () => {
    const gitea = new GiteaAPI("https://gitea.example.test", "token") as unknown as Record<string, unknown>;
    const github = new GithubAPI({ token: "token" }) as unknown as Record<string, unknown>;
    for (const method of ["cancelAutoMerge", "scheduleAutoMerge", "addIssueLabel", "addIssueAssignees"] as const) {
      expect(typeof gitea[method]).toBe("function");
      expect(typeof github[method]).toBe("function");
    }
  });

  test("timeline and repo-file reads exist on both adapters", () => {
    const gitea = new GiteaAPI("https://gitea.example.test", "token") as unknown as Record<string, unknown>;
    const github = new GithubAPI({ token: "token" }) as unknown as Record<string, unknown>;
    for (const method of ["getBranch", "getRepoFile", "listIssueTimeline", "deleteGitRef"] as const) {
      expect(typeof gitea[method]).toBe("function");
      expect(typeof github[method]).toBe("function");
    }
  });

  test("github-only optionals match the capabilities split", () => {
    const gitea = new GiteaAPI("https://gitea.example.test", "token") as unknown as Record<string, unknown>;
    const github = new GithubAPI({ token: "token" }) as unknown as Record<string, unknown>;
    // GitHub exposes the closing-issues and App-permission entrypoints;
    // Gitea leaves them absent so callers fall back to the shared parser.
    expect(typeof github.listClosingIssues).toBe("function");
    expect(gitea.listClosingIssues).toBeUndefined();
    expect(typeof github.getAppPermissions).toBe("function");
    expect(gitea.getAppPermissions).toBeUndefined();
    // The table still routes markers and schedules per kind.
    expect(FORGE_CAPABILITIES.github.takeoverMarker).toBe("label");
    expect(FORGE_CAPABILITIES.gitea.takeoverMarker).toBe("assignee");
  });
});

describe("merge-method strategy", () => {
  const github = () => forgeCapabilities("github").mergePolicy;
  const gitea = () => forgeCapabilities("gitea").mergePolicy;

  test("github kill switch only disables github", () => {
    expect(github().isAutoMergeDisabled({ allowAutoMerge: false })).toBe(true);
    expect(github().isAutoMergeDisabled({})).toBe(false);
    expect(gitea().isAutoMergeDisabled({ allowAutoMerge: false })).toBe(false);
    expect(gitea().isAutoMergeDisabled({})).toBe(false);
  });

  test("github configured method honors allow flags with no fallback", () => {
    const policy = github();
    expect(policy.methodForConfiguredRepo({}, "merge")).toBe("MERGE");
    expect(policy.methodForConfiguredRepo({ allowMergeCommit: false }, "merge")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "squash")).toBe("SQUASH");
    expect(policy.methodForConfiguredRepo({ allowSquashMerge: false }, "squash")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "rebase")).toBe("REBASE");
    expect(policy.methodForConfiguredRepo({ allowRebaseMerge: false }, "rebase")).toBeUndefined();
    // Gitea-only values never schedule on GitHub.
    expect(policy.methodForConfiguredRepo({}, "rebase-merge")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "fast-forward-only")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "unknown")).toBeUndefined();
  });

  test("github default method prefers merge, then squash, then rebase", () => {
    const policy = github();
    expect(policy.defaultMethod({ allowMergeCommit: true })).toEqual({ ok: true, mergeMethod: "MERGE" });
    expect(policy.defaultMethod({ allowMergeCommit: false, allowSquashMerge: true })).toEqual({
      ok: true,
      mergeMethod: "SQUASH",
    });
    expect(policy.defaultMethod({ allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: true })).toEqual({
      ok: true,
      mergeMethod: "REBASE",
    });
    expect(policy.defaultMethod({ allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: false })).toEqual(
      { ok: false, reason: "no-method" }
    );
    // Unknown (fakes, older forges): the GitHub default is MERGE.
    expect(policy.defaultMethod({})).toEqual({ ok: true, mergeMethod: "MERGE" });
  });

  test("gitea configured style honors allow flags with no fallback", () => {
    const policy = gitea();
    expect(policy.methodForConfiguredRepo({}, "merge")).toBe("merge");
    expect(policy.methodForConfiguredRepo({ allowMergeCommits: false }, "merge")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "squash")).toBe("squash");
    expect(policy.methodForConfiguredRepo({ allowSquashMerge: false }, "squash")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "rebase")).toBe("rebase");
    expect(policy.methodForConfiguredRepo({ allowRebase: false }, "rebase")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "rebase-merge")).toBe("rebase-merge");
    expect(policy.methodForConfiguredRepo({ allowRebaseExplicit: false }, "rebase-merge")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "fast-forward-only")).toBe("fast-forward-only");
    expect(policy.methodForConfiguredRepo({ allowFastForwardOnlyMerge: false }, "fast-forward-only")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "MERGE")).toBeUndefined();
    expect(policy.methodForConfiguredRepo({}, "unknown")).toBeUndefined();
  });

  test("gitea default style falls back to merge and fails closed on unknown", () => {
    const policy = gitea();
    expect(policy.defaultMethod({})).toEqual({ ok: true, mergeMethod: "merge" });
    expect(policy.defaultMethod({ defaultMergeStyle: "merge" })).toEqual({ ok: true, mergeMethod: "merge" });
    expect(policy.defaultMethod({ defaultMergeStyle: "squash" })).toEqual({ ok: true, mergeMethod: "squash" });
    expect(policy.defaultMethod({ defaultMergeStyle: "rebase" })).toEqual({ ok: true, mergeMethod: "rebase" });
    expect(policy.defaultMethod({ defaultMergeStyle: "rebase-merge" })).toEqual({
      ok: true,
      mergeMethod: "rebase-merge",
    });
    expect(policy.defaultMethod({ defaultMergeStyle: "fast-forward-only" })).toEqual({
      ok: true,
      mergeMethod: "fast-forward-only",
    });
    expect(policy.defaultMethod({ defaultMergeStyle: "weird" })).toEqual({ ok: false, reason: "unknown-style" });
  });
});
