import { afterEach, describe, expect, test } from "bun:test";
import { GiteaAPI } from "../src/api.ts";
import type { Pull } from "../src/ports.ts";
import {
  recheckStrictRefreshEligibility,
  shouldEnqueueStrictRefreshForPR,
  shouldEnqueueStrictRefreshOnPush,
} from "../src/strict_refresh.ts";
import {
  isGiteaScheduleArmed,
  readGiteaBehind,
  readGiteaScheduleArmed,
  resolveStrictPolicyWithFallback,
} from "../src/strict_refresh_gitea.ts";
import { MemoryStrictRefreshSlotStore } from "../src/strict_refresh_queue.ts";

function giteaPull(overrides: Partial<Pull> = {}): Pull {
  return {
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    state: "open",
    html_url: "https://gitea.example.test/o/r/pulls/127",
    user: { login: "jumi" },
    head: {
      ref: "jumi/issue-12-fix",
      sha: "headsha",
      repo: { full_name: "o/r", clone_url: "https://gitea.example.test/o/r.git" },
    },
    base: { ref: "main", sha: "basesha" },
    merged: false,
    draft: false,
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

function pushPayload(after = "base2") {
  return {
    ref: "refs/heads/main",
    before: "base1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://gitea.example.test/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  } as never;
}

const giteaPolicy = {
  giteaUrl: "https://gitea.example.test",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
  forgeKind: "gitea",
} as never;

function giteaApi(
  opts: {
    strict?: boolean | undefined | "throw403";
    scheduled?: boolean | "cancelled" | "none";
    behind?: number | "error";
    optIn?: boolean;
  } = {}
): any {
  const { strict, scheduled = true, behind = 2, optIn = false } = opts;
  return {
    capabilities: { kind: "gitea" },
    listOpenPulls: async () => [giteaPull()],
    getBranch: async () => {
      if (strict === "throw403") throw new Error("Gitea API GET /repos/o/r/branch_protections/main → 403: forbidden");
      if (strict === undefined) return { protected: true } as never;
      return { protected: true, strict } as never;
    },
    listIssueTimeline: async () => {
      if (scheduled === "none") return [];
      if (scheduled === "cancelled") return [{ type: "pull_scheduled_merge" }, { type: "pull_cancel_scheduled_merge" }];
      return [{ type: "pull_scheduled_merge" }];
    },
    compareCommits: async () => {
      if (behind === "error") throw new Error("Gitea API GET /repos/o/r/compare/x...main → 500: boom");
      return { totalCommits: behind };
    },
    getRepoFile: async () => {
      if (!optIn) return { found: false };
      return { found: true, content: "strict_branch_refresh: true\n" };
    },
  };
}

describe("gitea strict policy source", () => {
  test("admin rule strict wins", async () => {
    expect(await resolveStrictPolicyWithFallback(giteaApi({ strict: true }), "o", "r", "main", {})).toBe("strict");
  });
  test("admin rule off wins over opt-in", async () => {
    expect(
      await resolveStrictPolicyWithFallback(giteaApi({ strict: false, optIn: true }), "o", "r", "main", {
        defaultBranch: "main",
      })
    ).toBe("off");
  });
  test("403 falls back to opt-in", async () => {
    expect(
      await resolveStrictPolicyWithFallback(giteaApi({ strict: "throw403", optIn: true }), "o", "r", "main", {
        defaultBranch: "main",
      })
    ).toBe("strict");
  });
  test("403 without opt-in is unknown (today's no-op)", async () => {
    expect(
      await resolveStrictPolicyWithFallback(giteaApi({ strict: "throw403" }), "o", "r", "main", {
        defaultBranch: "main",
      })
    ).toBe("unknown");
  });
  test("github ignores the file", async () => {
    expect(
      await resolveStrictPolicyWithFallback(giteaApi({ strict: undefined, optIn: true }), "o", "r", "main", {
        forgeKind: "github",
        defaultBranch: "main",
      })
    ).toBe("unknown");
  });
});

describe("gitea schedule and behind", () => {
  test("latest event wins; none means not armed", () => {
    expect(isGiteaScheduleArmed([{ type: "pull_scheduled_merge" }])).toBe(true);
    expect(isGiteaScheduleArmed([{ type: "pull_cancel_scheduled_merge" }])).toBe(false);
    expect(isGiteaScheduleArmed([{ type: "pull_scheduled_merge" }, { type: "pull_cancel_scheduled_merge" }])).toBe(
      false
    );
    expect(isGiteaScheduleArmed([{ type: "pull_cancel_scheduled_merge" }, { type: "pull_scheduled_merge" }])).toBe(
      true
    );
    expect(isGiteaScheduleArmed([])).toBe(false);
  });
  test("unreadable timeline is not armed", async () => {
    expect(await readGiteaScheduleArmed({}, "o", "r", 127)).toBe(false);
    expect(
      await readGiteaScheduleArmed(
        {
          listIssueTimeline: async () => {
            throw new Error("boom");
          },
        },
        "o",
        "r",
        127
      )
    ).toBe(false);
  });
  test("compare behind true only when total_commits > 0", async () => {
    const api = { compareCommits: async () => ({ totalCommits: 2 }) };
    expect(await readGiteaBehind(api, "o", "r", "head", "main")).toBe(true);
    expect(await readGiteaBehind({ compareCommits: async () => ({ totalCommits: 0 }) }, "o", "r", "head", "main")).toBe(
      false
    );
    expect(
      await readGiteaBehind(
        {
          compareCommits: async () => {
            throw new Error("boom");
          },
        },
        "o",
        "r",
        "head",
        "main"
      )
    ).toBe(false);
    expect(await readGiteaBehind({}, "o", "r", "head", "main")).toBe(false);
  });
});

describe("gitea push enqueue", () => {
  test("rule readable: enqueues oldest ready", async () => {
    const api = giteaApi({ strict: true });
    api.listOpenPulls = async () => [giteaPull({ number: 100 }), giteaPull({ number: 101 })];
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base2"), giteaPolicy, api);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(100);
  });
  test("403 with opt-in: same sequence works", async () => {
    const api = giteaApi({ strict: "throw403", optIn: true });
    api.listOpenPulls = async () => [giteaPull({ number: 100 })];
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base2"), giteaPolicy, api);
    expect(jobs).toHaveLength(1);
  });
  test("403 without opt-in: no refresh", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      giteaApi({ strict: "throw403" })
    );
    expect(jobs).toHaveLength(0);
  });
  test("rule off plus opt-in: no refresh", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      giteaApi({ strict: false, optIn: true })
    );
    expect(jobs).toHaveLength(0);
  });
  test("no schedule: not a candidate", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      giteaApi({ strict: true, scheduled: "none" })
    );
    expect(jobs).toHaveLength(0);
  });
  test("later cancel: not a candidate", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      giteaApi({ strict: true, scheduled: "cancelled" })
    );
    expect(jobs).toHaveLength(0);
  });
  test("compare 0 or error: no refresh", async () => {
    for (const behind of [0, "error"] as const) {
      const { jobs } = await shouldEnqueueStrictRefreshOnPush(
        pushPayload("base2"),
        giteaPolicy,
        giteaApi({ strict: true, behind })
      );
      expect(jobs).toHaveLength(0);
    }
  });
  test("single-slot holds across ten stale PRs", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const pulls = Array.from({ length: 10 }, (_, i) =>
      giteaPull({
        number: 100 + i,
        head: { ref: `jumi/issue-${100 + i}-fix`, sha: `head-${100 + i}`, repo: { full_name: "o/r" } },
      })
    );
    const api = giteaApi({ strict: true });
    api.listOpenPulls = async () => pulls;
    const first = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      api,
      undefined,
      slots,
      1000
    );
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(100);
    const second = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base2"),
      giteaPolicy,
      api,
      undefined,
      slots,
      2000
    );
    expect(second.jobs).toHaveLength(0);
  });
});

describe("gitea PR-activity reconcile", () => {
  test("already-behind scheduled PR is picked up", async () => {
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: giteaPull(),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://gitea.example.test/o/r.git",
      policy: giteaPolicy,
      api: giteaApi({ strict: true }),
    });
    expect(job?.mergeOnly).toBe(true);
  });
  test("unscheduled or cancelled: nothing written", async () => {
    for (const scheduled of ["none", "cancelled"] as const) {
      const job = await shouldEnqueueStrictRefreshForPR({
        pr: giteaPull(),
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        cloneUrl: "https://gitea.example.test/o/r.git",
        policy: giteaPolicy,
        api: giteaApi({ strict: true, scheduled }),
      });
      expect(job).toBeNull();
    }
  });
  test("up-to-date or unreadable compare: no refresh", async () => {
    for (const behind of [0, "error"] as const) {
      const job = await shouldEnqueueStrictRefreshForPR({
        pr: giteaPull(),
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        cloneUrl: "https://gitea.example.test/o/r.git",
        policy: giteaPolicy,
        api: giteaApi({ strict: true, behind }),
      });
      expect(job).toBeNull();
    }
  });
});

describe("gitea worker recheck", () => {
  test("armed, behind, strict proceeds; cancel or up-to-date skips without re-arm", async () => {
    const pr = giteaPull();
    const base = {
      getPR: async () => pr,
      getBranch: async () => ({ protected: true, strict: true }),
      listIssueTimeline: async () => [{ type: "pull_scheduled_merge" }],
      compareCommits: async () => ({ totalCommits: 2 }),
    };
    const ok = await recheckStrictRefreshEligibility({
      api: base as never,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      policy: { botUsername: "jumi", forgeKind: "gitea" } as never,
      defaultBranch: "main",
    });
    expect(ok.skipReason).toBeNull();

    const cancelled = await recheckStrictRefreshEligibility({
      api: { ...base, listIssueTimeline: async () => [{ type: "pull_cancel_scheduled_merge" }] } as never,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      policy: { botUsername: "jumi", forgeKind: "gitea" } as never,
      defaultBranch: "main",
    });
    expect(cancelled.skipReason).toBe("strict refresh: auto-merge no longer armed");

    const clean = await recheckStrictRefreshEligibility({
      api: { ...base, compareCommits: async () => ({ totalCommits: 0 }) } as never,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      policy: { botUsername: "jumi", forgeKind: "gitea" } as never,
      defaultBranch: "main",
    });
    expect(clean.skipReason).toBe("strict refresh: not behind");
  });
});

describe("GiteaAPI strict branches", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("admin token resolves block_on_outdated_branch to strict", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("/branches/main")) {
        return Response.json({ protected: true, effective_branch_protection_name: "main" });
      }
      if (href.includes("/branch_protections/main")) {
        return Response.json({ block_on_outdated_branch: true });
      }
      throw new Error(`unexpected ${href}`);
    }) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    expect(await api.getBranch("o", "r", "main")).toMatchObject({ strict: true });
  });

  test("write token without effective name leaves strict unknown", async () => {
    globalThis.fetch = (async () => Response.json({ protected: true })) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    expect(await api.getBranch("o", "r", "main")).not.toHaveProperty("strict");
  });

  test("compare returns total_commits behind count", async () => {
    let seen = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return Response.json({ total_commits: 4 });
    }) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    expect(await api.compareCommits("o", "r", "headsha...main")).toEqual({ totalCommits: 4 });
    expect(seen).toContain("/compare/headsha...main");
    expect(seen).toContain("files=false");
  });
});
