import { describe, expect, test } from "bun:test";
import { shouldEnqueuePullLabel } from "../src/followup_webhook.ts";
import { shouldEnqueueGithubIssue } from "../src/github_webhook.ts";
import { senderCanSteer } from "../src/permissions.ts";
import {
  effectiveFollowupIgnoreLogins,
  effectiveIgnoreConflictsLabel,
  effectivePickupLabel,
  effectiveTrustedSenderLogins,
  loadEffectiveFollowupIgnoreLogins,
  loadEffectiveIgnoreConflictsLabel,
  loadEffectivePickupLabel,
  loadEffectiveTrustedSenderLogins,
  parseRepoSettingsText,
} from "../src/repo_settings.ts";
import { maybeTakeoverPr } from "../src/takeover.ts";
import { makeIssue, makeIssuePayload, makePR, makeRepo, makeUser } from "./fixtures.ts";

function repoFileApi(content: string | undefined, opts?: { throw?: Error }) {
  return {
    getRepoFile: async () => {
      if (opts?.throw) throw opts.throw;
      if (content === undefined) return { found: false };
      return { found: true, content };
    },
  };
}

describe("trusted_senders parser", () => {
  test("parses a login list", () => {
    const parsed = parseRepoSettingsText("trusted_senders:\n  - Alice\n  - bob\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.trustedSenders).toEqual(["Alice", "bob"]);
  });

  test("empty list is invalid", () => {
    expect(parseRepoSettingsText("trusted_senders: []\n")).toEqual({
      ok: false,
      error:
        '"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only',
    });
  });

  test("blank or non-string entries invalidate", () => {
    expect(parseRepoSettingsText('trusted_senders:\n  - ""\n').ok).toBe(false);
    expect(parseRepoSettingsText("trusted_senders: [alice, 1]\n").ok).toBe(false);
    expect(parseRepoSettingsText("trusted_senders: alice\n").ok).toBe(false);
  });

  test("dash and camel spellings are rejected with did you mean", () => {
    expect(parseRepoSettingsText("trusted-senders: [a]\n")).toEqual({
      ok: false,
      error: 'unknown key "trusted-senders" (did you mean "trusted_senders"?)',
    });
    expect(parseRepoSettingsText("trustedSenders: [a]\n")).toEqual({
      ok: false,
      error: 'unknown key "trustedSenders" (did you mean "trusted_senders"?)',
    });
  });
});

describe("followup_ignore_logins parser", () => {
  test("parses and allows empty", () => {
    const parsed = parseRepoSettingsText("followup_ignore_logins:\n  - preview-bot\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.followupIgnoreLogins).toEqual(["preview-bot"]);
    expect(parseRepoSettingsText("followup_ignore_logins: []\n").ok).toBe(true);
  });

  test("blank entries invalidate, dash/camel suggest", () => {
    expect(parseRepoSettingsText('followup_ignore_logins:\n  - "  "\n').ok).toBe(false);
    expect(parseRepoSettingsText("followup-ignore-logins: [a]\n")).toEqual({
      ok: false,
      error: 'unknown key "followup-ignore-logins" (did you mean "followup_ignore_logins"?)',
    });
    expect(parseRepoSettingsText("followupIgnoreLogins: [a]\n")).toEqual({
      ok: false,
      error: 'unknown key "followupIgnoreLogins" (did you mean "followup_ignore_logins"?)',
    });
  });
});

describe("label parser", () => {
  test("ignore_conflicts_label and pickup_label parse and validate", () => {
    expect(parseRepoSettingsText("ignore_conflicts_label: skip-me\n").ok).toBe(true);
    expect(parseRepoSettingsText("pickup_label: here\n").ok).toBe(true);
    expect(parseRepoSettingsText('ignore_conflicts_label: ""\n')).toEqual({
      ok: false,
      error: '"ignore_conflicts_label" must be a non-blank string',
    });
    expect(parseRepoSettingsText("pickup_label: 42\n")).toEqual({
      ok: false,
      error: '"pickup_label" must be a non-blank string',
    });
    expect(parseRepoSettingsText("ignore-conflicts-label: x\n")).toEqual({
      ok: false,
      error: 'unknown key "ignore-conflicts-label" (did you mean "ignore_conflicts_label"?)',
    });
    expect(parseRepoSettingsText("pickupLabel: x\n")).toEqual({
      ok: false,
      error: 'unknown key "pickupLabel" (did you mean "pickup_label"?)',
    });
  });
});

describe("effectiveTrustedSenderLogins", () => {
  test("narrows a set env list and never widens it", () => {
    const narrowed = effectiveTrustedSenderLogins(["alice", "bob"], {
      state: "valid",
      automerge: false,
      automergeLabel: "automerge",
      noAutomergeLabel: "no-automerge",
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      trustedSenders: ["Alice", "carol"],
      mode: "full",
    });
    expect(narrowed).toEqual(["Alice"]);
    const widened = effectiveTrustedSenderLogins(["alice"], {
      state: "valid",
      automerge: false,
      automergeLabel: "automerge",
      noAutomergeLabel: "no-automerge",
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      trustedSenders: ["alice", "bob"],
      mode: "full",
    });
    expect(widened).toEqual(["alice"]);
  });

  test("repo list alone admits when the env is unset", async () => {
    const effective = effectiveTrustedSenderLogins([], {
      state: "valid",
      automerge: false,
      automergeLabel: "automerge",
      noAutomergeLabel: "no-automerge",
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      trustedSenders: ["carol"],
      mode: "full",
    });
    expect(effective).toEqual(["carol"]);
    // Listing is the admit: no forge lookup, case-insensitive whole login.
    expect(await senderCanSteer(undefined, "o", "r", "CAROL", effective)).toBe(true);
    expect(await senderCanSteer(undefined, "o", "r", "bob", effective)).toBe(false);
    expect(await senderCanSteer(undefined, "o", "r", "carolx", effective)).toBe(false);
  });

  test("neither set means write-access fallback", () => {
    expect(
      effectiveTrustedSenderLogins([], {
        state: "valid",
        automerge: false,
        automergeLabel: "automerge",
        noAutomergeLabel: "no-automerge",
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      })
    ).toBeUndefined();
  });

  test("invalid file never widens access", async () => {
    const api = repoFileApi("trusted_senders: 1\n");
    expect(await loadEffectiveTrustedSenderLogins(api, "o", "r", "main", ["alice"])).toEqual(["alice"]);
    expect(await loadEffectiveTrustedSenderLogins(api, "o", "r", "main", [])).toBeUndefined();
    // Narrowing still applies through the loader when valid.
    const valid = repoFileApi("trusted_senders:\n  - alice\n  - bob\n");
    expect(await loadEffectiveTrustedSenderLogins(valid, "o", "r", "main", ["alice", "carol"])).toEqual(["alice"]);
  });

  test("unreadable file falls back to the deployment list", async () => {
    const api = repoFileApi(undefined, { throw: new Error("GitHub API → 500") });
    expect(await loadEffectiveTrustedSenderLogins(api, "o", "r", "main", ["alice"])).toEqual(["alice"]);
  });
});

describe("effectiveFollowupIgnoreLogins", () => {
  test("unions with the env and cannot remove deployer logins", async () => {
    const api = repoFileApi("followup_ignore_logins:\n  - repo-bot\n");
    expect(await loadEffectiveFollowupIgnoreLogins(api, "o", "r", "main", ["deployer-bot"])).toEqual([
      "deployer-bot",
      "repo-bot",
    ]);
    const merged = effectiveFollowupIgnoreLogins(["deployer-bot"], {
      state: "valid",
      automerge: false,
      automergeLabel: "automerge",
      noAutomergeLabel: "no-automerge",
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      followupIgnoreLogins: ["DEPLOYER-bot", "repo-bot"],
      mode: "full",
    });
    expect(merged).toEqual(["deployer-bot", "repo-bot"]);
    const missing = repoFileApi(undefined);
    expect(await loadEffectiveFollowupIgnoreLogins(missing, "o", "r", "main", ["deployer-bot"])).toEqual([
      "deployer-bot",
    ]);
  });
});

describe("effectiveIgnoreConflictsLabel", () => {
  test("overrides and falls back to the env", async () => {
    const api = repoFileApi("ignore_conflicts_label: skip-me\n");
    expect(await loadEffectiveIgnoreConflictsLabel(api, "o", "r", "main", "ignore-conflicts")).toBe("skip-me");
    const missing = repoFileApi(undefined);
    expect(await loadEffectiveIgnoreConflictsLabel(missing, "o", "r", "main", "ignore-conflicts")).toBe(
      "ignore-conflicts"
    );
    const invalid = repoFileApi("ignore_conflicts_label: 1\n");
    expect(await loadEffectiveIgnoreConflictsLabel(invalid, "o", "r", "main", "ignore-conflicts")).toBe(
      "ignore-conflicts"
    );
    expect(
      effectiveIgnoreConflictsLabel("ignore-conflicts", {
        state: "valid",
        automerge: false,
        automergeLabel: "automerge",
        noAutomergeLabel: "no-automerge",
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        ignoreConflictsLabel: "skip-me",
        mode: "full",
      })
    ).toBe("skip-me");
  });
});

describe("pickup_label on GitHub", () => {
  const repo = makeRepo({
    full_name: "o/r",
    html_url: "https://github.com/o/r",
    clone_url: "https://github.com/o/r.git",
  });
  const basePolicy = {
    giteaUrl: "https://github.com",
    allowedOrgs: ["o"],
    allowedRepos: [] as string[],
    botUsername: "jumi",
  };

  function issuePayload(labelName: string) {
    return makeIssuePayload({
      action: "labeled",
      issue: makeIssue({ labels: [{ name: labelName }] }),
      label: { name: labelName },
      repository: repo,
      sender: makeUser({ login: "alice", type: "User" }),
    });
  }

  test("custom label starts pickup and handover, jumi no longer does", async () => {
    const custom = { ...basePolicy, pickupLabel: "here" };
    expect(shouldEnqueueGithubIssue(issuePayload("here"), custom).type).toBe("enqueue");
    expect(shouldEnqueueGithubIssue(issuePayload("jumi"), custom)).toEqual({
      type: "skip",
      reason: "labeled other label",
    });
    const headRepo = makeRepo({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
    });
    const pr = makePR({
      labels: [{ name: "here" }],
      head: {
        label: "o/r:feature",
        ref: "feature",
        sha: "headsha",
        repo: headRepo,
        repo_id: 10,
      },
    });
    expect(
      (
        await shouldEnqueuePullLabel(
          {
            action: "labeled",
            number: 7,
            pull_request: pr,
            repository: repo,
            sender: makeUser({ login: "alice" }),
            label: { name: "here" },
          } as never,
          { ...basePolicy, botUsername: "jumi", pickupLabel: "here" }
        )
      ).type
    ).toBe("enqueue");
    expect(
      (
        await shouldEnqueuePullLabel(
          {
            action: "labeled",
            number: 7,
            pull_request: makePR({
              labels: [{ name: "jumi" }],
              head: {
                label: "o/r:feature",
                ref: "feature",
                sha: "headsha",
                repo: headRepo,
                repo_id: 10,
              },
            }),
            repository: repo,
            sender: makeUser({ login: "alice" }),
            label: { name: "jumi" },
          } as never,
          { ...basePolicy, botUsername: "jumi", pickupLabel: "here" }
        )
      ).type
    ).toBe("skip");
  });

  test("invalid file falls back to jumi", async () => {
    const invalid = repoFileApi("pickup_label: 1\n");
    expect(await loadEffectivePickupLabel(invalid, "o", "r", "main")).toBe("jumi");
    const missing = repoFileApi(undefined);
    expect(await loadEffectivePickupLabel(missing, "o", "r", "main")).toBe("jumi");
    const unreadable = repoFileApi(undefined, { throw: new Error("GitHub API → 500") });
    expect(await loadEffectivePickupLabel(unreadable, "o", "r", "main")).toBe("jumi");
    const valid = repoFileApi("pickup_label: here\n");
    expect(await loadEffectivePickupLabel(valid, "o", "r", "main")).toBe("here");
    expect(effectivePickupLabel({ state: "missing" })).toBe("jumi");
  });
});

describe("takeover with repo trusted_senders", () => {
  test("narrows the deployer list and never widens it", async () => {
    const added: string[] = [];
    const baseApi = {
      getRepoFile: async () => ({
        found: true,
        content: "takeover_authors:\n  - alice\n  - bob\ntrusted_senders:\n  - alice\n",
      }),
      getCollaboratorPermission: async () => ({ permission: "read", role_name: "read" }),
      addIssueLabel: async (_o: string, _r: string, _n: number, label: string) => {
        added.push(label);
        return undefined;
      },
    };
    // Alice is in the intersection, so she is taken over even without write access.
    const alice = await maybeTakeoverPr({
      api: baseApi as never,
      forgeKind: "github",
      owner: "o",
      repo: "r",
      prNumber: 7,
      prAuthorLogin: "alice",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: ["alice", "carol"],
    });
    expect(alice).toEqual({ takeover: true, refused: false });
    expect(added).toEqual(["jumi"]);
    // Bob is listed for takeover but outside the deployer intersection, so he is refused.
    const bob = await maybeTakeoverPr({
      api: baseApi as never,
      forgeKind: "github",
      owner: "o",
      repo: "r",
      prNumber: 8,
      prAuthorLogin: "bob",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: ["alice", "carol"],
    });
    expect(bob).toEqual({ takeover: false, refused: true });
  });

  test("repo list alone admits when the env is unset", async () => {
    const api = {
      getRepoFile: async () => ({
        found: true,
        content: "takeover_authors:\n  - carol\ntrusted_senders:\n  - carol\n",
      }),
      getCollaboratorPermission: async () => ({ permission: "read", role_name: "read" }),
      addIssueLabel: async () => undefined,
    };
    const outcome = await maybeTakeoverPr({
      api: api as never,
      forgeKind: "github",
      owner: "o",
      repo: "r",
      prNumber: 9,
      prAuthorLogin: "carol",
      defaultBranch: "main",
      botUsername: "jumi",
      trustedSenderLogins: [],
    });
    expect(outcome).toEqual({ takeover: true, refused: false });
  });
});
