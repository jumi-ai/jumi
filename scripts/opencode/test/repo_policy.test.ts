import { describe, expect, test } from "bun:test";
import { hasLabel } from "../src/assignee.ts";
import { effectiveGithubPolicyForRepo } from "../src/github_webhook.ts";
import { deriveRepoPolicy, type RepoPolicyDeployment, resolveRepoPolicy } from "../src/repo_policy.ts";
import {
  effectiveBlockingQuestionAuthors,
  effectiveCiGateWait,
  effectiveConflictRounds,
  effectiveFollowupIgnoreLogins,
  effectiveFollowupRounds,
  effectiveIgnoreConflictsLabel,
  effectivePickupLabel,
  effectiveTrustedSenderLogins,
  isSuggestionFollowupEnabled,
  repoMode,
} from "../src/repo_settings.ts";
import { effectiveWorkerPolicyForRepo } from "../src/worker_webhook.ts";
import { makeForgeApi } from "./fakes/forge.ts";

const deployment: RepoPolicyDeployment = {
  trustedSenderLogins: ["Alice", "Bob"],
  followupIgnoreLogins: ["deploy-bot"],
  ignoreConflictsLabel: "ignore-conflicts",
  blockingQuestionAuthors: ["reviewer"],
  maxFollowupRounds: 3,
  maxConflictRounds: 3,
};

function validYaml(): string {
  return [
    "trusted_senders: [alice]",
    "followup_ignore_logins: [repo-bot]",
    "ignore_conflicts_label: repo-ignore",
    "blocking_question_authors: [repo-reviewer]",
    "max_followup_rounds: 2",
    "max_conflict_rounds: 1",
    "followup_on_suggestions: false",
    "pickup_label: take-me",
    "ci_gate: {wait: none}",
    "mode: review-only",
    "",
  ].join("\n");
}

describe("resolveRepoPolicy load-state table", () => {
  test("missing file returns deployment-only policy with status missing", async () => {
    const api = makeForgeApi({ getRepoFile: async () => ({ found: false }) });
    const policy = await resolveRepoPolicy({ api, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(policy.status).toBe("missing");
    expect(policy.load).toEqual({ state: "missing" });
    expect(policy.error).toBeUndefined();
    expect(policy.trustedSenderLogins).toEqual(["Alice", "Bob"]);
    expect(policy.followupIgnoreLogins).toEqual(["deploy-bot"]);
    expect(policy.ignoreConflictsLabel).toBe("ignore-conflicts");
    expect(policy.blockingQuestionAuthors).toEqual(["reviewer"]);
    expect(policy.maxFollowupRounds).toBe(3);
    expect(policy.maxConflictRounds).toBe(3);
    expect(policy.followupOnSuggestions).toBe(true);
    expect(policy.pickupLabel).toBe("jumi");
    expect(policy.ciGateWait).toBe("required");
    expect(policy.mode).toBe("full");
    expect(api.callsTo("getRepoFile")).toHaveLength(1);
  });

  test("invalid file keeps deployment caps with status invalid", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: "trusted_senders: nope\n" }),
    });
    const policy = await resolveRepoPolicy({ api, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(policy.status).toBe("invalid");
    expect(policy.load.state).toBe("invalid");
    expect(typeof policy.error).toBe("string");
    // Invalid never widens: same as the direct helpers on the invalid load.
    expect(policy.trustedSenderLogins).toEqual(
      effectiveTrustedSenderLogins(deployment.trustedSenderLogins, policy.load)
    );
    expect(policy.maxFollowupRounds).toBe(3);
    expect(policy.maxConflictRounds).toBe(3);
    expect(policy.followupOnSuggestions).toBe(true);
  });

  test("valid file with each override resolves every field", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: validYaml() }),
    });
    const policy = await resolveRepoPolicy({ api, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(policy.status).toBe("ok");
    expect(policy.load.state).toBe("valid");
    // Same as calling the existing helpers directly on the load.
    expect(policy.trustedSenderLogins).toEqual(
      effectiveTrustedSenderLogins(deployment.trustedSenderLogins, policy.load)
    );
    expect(policy.followupIgnoreLogins).toEqual(
      effectiveFollowupIgnoreLogins(deployment.followupIgnoreLogins, policy.load)
    );
    expect(policy.ignoreConflictsLabel).toEqual(
      effectiveIgnoreConflictsLabel(deployment.ignoreConflictsLabel, policy.load)
    );
    expect(policy.blockingQuestionAuthors).toEqual(
      effectiveBlockingQuestionAuthors(deployment.blockingQuestionAuthors, policy.load)
    );
    expect(policy.maxFollowupRounds).toEqual(effectiveFollowupRounds(deployment.maxFollowupRounds, policy.load));
    expect(policy.maxConflictRounds).toEqual(effectiveConflictRounds(deployment.maxConflictRounds, policy.load));
    expect(policy.followupOnSuggestions).toEqual(isSuggestionFollowupEnabled(policy.load));
    expect(policy.pickupLabel).toEqual(effectivePickupLabel(policy.load));
    expect(policy.ciGateWait).toEqual(effectiveCiGateWait(policy.load));
    expect(policy.mode).toEqual(repoMode(policy.load));
    // Spot-check the override values themselves.
    expect(policy.trustedSenderLogins).toEqual(["alice"]);
    expect(policy.followupIgnoreLogins).toEqual(["deploy-bot", "repo-bot"]);
    expect(policy.ignoreConflictsLabel).toBe("repo-ignore");
    expect(policy.blockingQuestionAuthors).toEqual(["reviewer", "repo-reviewer"]);
    expect(policy.maxFollowupRounds).toBe(2);
    expect(policy.maxConflictRounds).toBe(1);
    expect(policy.followupOnSuggestions).toBe(false);
    expect(policy.pickupLabel).toBe("take-me");
    expect(policy.ciGateWait).toBe("none");
    expect(policy.mode).toBe("review-only");
  });

  test("throwing read falls back with status unreadable, or rethrows", async () => {
    const throwing = makeForgeApi({
      getRepoFile: async () => {
        throw new Error("boom");
      },
    });
    const fallback = await resolveRepoPolicy({ api: throwing, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(fallback.status).toBe("unreadable");
    expect(fallback.load).toEqual({ state: "missing" });
    expect(fallback.error).toContain("boom");
    expect(fallback.trustedSenderLogins).toEqual(["Alice", "Bob"]);
    expect(fallback.maxFollowupRounds).toBe(3);

    let thrown: unknown;
    try {
      await resolveRepoPolicy({ api: throwing, owner: "o", repo: "r", ref: "main" }, deployment, {
        onUnreadable: "throw",
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("boom");
  });

  test("no file API or empty branch returns missing without reading", async () => {
    const noApi = await resolveRepoPolicy({ api: undefined, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(noApi.status).toBe("missing");
    expect(noApi.load).toEqual({ state: "missing" });

    const noMethod = await resolveRepoPolicy({ api: {}, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
    });
    expect(noMethod.status).toBe("missing");

    const api = makeForgeApi({ getRepoFile: async () => ({ found: true, content: validYaml() }) });
    const empty = await resolveRepoPolicy({ api, owner: "o", repo: "r", ref: "  " }, deployment, {
      onUnreadable: "fallback",
    });
    expect(empty.status).toBe("missing");
    expect(api.callsTo("getRepoFile")).toHaveLength(0);
  });

  test("reuse returns the memoised policy without reading", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => {
        throw new Error("must not read");
      },
    });
    const first = await resolveRepoPolicy(
      { api: makeForgeApi({ getRepoFile: async () => ({ found: false }) }), owner: "o", repo: "r", ref: "main" },
      deployment,
      { onUnreadable: "fallback" }
    );
    const second = await resolveRepoPolicy({ api, owner: "o", repo: "r", ref: "main" }, deployment, {
      onUnreadable: "fallback",
      reuse: first,
    });
    expect(second).toBe(first);
    expect(api.callsTo("getRepoFile")).toHaveLength(0);
  });
});

describe("migrated sites keep the same output", () => {
  test("followup bundle: caps, suggestion flag and lists match the helpers", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: validYaml() }),
    });
    const policy = await resolveRepoPolicy(
      { api, owner: "o", repo: "r", ref: "main" },
      {
        trustedSenderLogins: ["Alice"],
        followupIgnoreLogins: [],
        ignoreConflictsLabel: undefined,
        blockingQuestionAuthors: [],
        maxFollowupRounds: 3,
        maxConflictRounds: 3,
      },
      { onUnreadable: "fallback" }
    );
    // What needsFollowUp/implementFollowUp used to assign from the helpers.
    expect(policy.maxFollowupRounds).toBe(effectiveFollowupRounds(3, policy.load));
    expect(policy.followupOnSuggestions).toBe(isSuggestionFollowupEnabled(policy.load));
    expect(policy.blockingQuestionAuthors).toEqual(effectiveBlockingQuestionAuthors([], policy.load));
    expect(policy.followupIgnoreLogins).toEqual(effectiveFollowupIgnoreLogins([], policy.load));
    expect(policy.trustedSenderLogins).toEqual(effectiveTrustedSenderLogins(["Alice"], policy.load));
  });

  test("handover: invalid keeps deployment caps, blocking still derives", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: "trusted_senders: nope\n" }),
    });
    const policy = await resolveRepoPolicy(
      { api, owner: "o", repo: "r", ref: "main" },
      { ...deployment, blockingQuestionAuthors: ["reviewer"] },
      { onUnreadable: "throw" }
    );
    expect(policy.status).toBe("invalid");
    expect(policy.maxFollowupRounds).toBe(3);
    expect(policy.blockingQuestionAuthors).toEqual(effectiveBlockingQuestionAuthors(["reviewer"], policy.load));
  });

  test("worker: derived values come from the already-loaded settings", async () => {
    const api = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: validYaml() }),
    });
    const { load } = await (async () => {
      const { loadDefaultBranchSettings } = await import("../src/repo_settings.ts");
      return loadDefaultBranchSettings(api, "o", "r", "main");
    })();
    const policy = deriveRepoPolicy(load, deployment);
    expect(policy.trustedSenderLogins).toEqual(effectiveTrustedSenderLogins(deployment.trustedSenderLogins, load));
    expect(policy.followupIgnoreLogins).toEqual(effectiveFollowupIgnoreLogins(deployment.followupIgnoreLogins, load));
    expect(policy.ignoreConflictsLabel).toEqual(effectiveIgnoreConflictsLabel(deployment.ignoreConflictsLabel, load));
    expect(policy.pickupLabel).toEqual(effectivePickupLabel(load));
  });

  test("worker_webhook: only valid changes the three fields", async () => {
    const base = {
      giteaUrl: "https://example.test",
      allowedOrgs: [],
      allowedRepos: [],
      botUsername: "jumi",
      trustedSenderLogins: ["Alice"] as readonly string[],
      followupIgnoreLogins: [] as readonly string[],
      ignoreConflictsLabel: "ignore-conflicts",
    };
    const missingApi = makeForgeApi({ getRepoFile: async () => ({ found: false }) });
    expect(await effectiveWorkerPolicyForRepo(missingApi, "o", "r", "main", base)).toBe(base);

    const invalidApi = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: "trusted_senders: nope\n" }),
    });
    const invalidLogs: string[] = [];
    expect(await effectiveWorkerPolicyForRepo(invalidApi, "o", "r", "main", base, (m) => invalidLogs.push(m))).toBe(
      base
    );
    expect(invalidLogs.some((m) => m.includes("invalid"))).toBe(true);

    const throwingApi = makeForgeApi({
      getRepoFile: async () => {
        throw new Error("boom");
      },
    });
    const unreadableLogs: string[] = [];
    expect(await effectiveWorkerPolicyForRepo(throwingApi, "o", "r", "main", base, (m) => unreadableLogs.push(m))).toBe(
      base
    );
    expect(unreadableLogs.some((m) => m.includes("unreadable"))).toBe(true);

    expect(await effectiveWorkerPolicyForRepo(undefined, "o", "r", "main", base)).toBe(base);
    expect(await effectiveWorkerPolicyForRepo(missingApi, "o", "r", "", base)).toBe(base);

    const validApi = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: validYaml() }),
    });
    const valid = await effectiveWorkerPolicyForRepo(validApi, "o", "r", "main", base);
    expect(valid.trustedSenderLogins).toEqual(["alice"]);
    expect(valid.followupIgnoreLogins).toEqual(["repo-bot"]);
    expect(valid.ignoreConflictsLabel).toBe("repo-ignore");
  });

  test("github_webhook: missing still sets the pickup label", async () => {
    const base = {
      giteaUrl: "https://example.test",
      allowedOrgs: [],
      allowedRepos: [],
      botUsername: "jumi",
      trustedSenderLogins: ["Alice"] as readonly string[],
      followupIgnoreLogins: [] as readonly string[],
      ignoreConflictsLabel: "ignore-conflicts",
    };
    const missingApi = makeForgeApi({ getRepoFile: async () => ({ found: false }) });
    const missing = await effectiveGithubPolicyForRepo(missingApi, "o", "r", "main", base);
    expect(missing.pickupLabel).toBe("jumi");
    expect(
      missing.isPickedUp?.({ labels: [{ name: "jumi" }] } as unknown as Parameters<
        NonNullable<typeof missing.isPickedUp>
      >[0])
    ).toBe(true);
    expect(hasLabel({ labels: [{ name: "jumi" }] }, "jumi")).toBe(true);

    const invalidApi = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: "trusted_senders: nope\n" }),
    });
    expect(await effectiveGithubPolicyForRepo(invalidApi, "o", "r", "main", base)).toBe(base);

    const validApi = makeForgeApi({
      getRepoFile: async () => ({ found: true, content: validYaml() }),
    });
    const valid = await effectiveGithubPolicyForRepo(validApi, "o", "r", "main", base);
    expect(valid.pickupLabel).toBe("take-me");
    expect(valid.trustedSenderLogins).toEqual(["alice"]);
  });
});
