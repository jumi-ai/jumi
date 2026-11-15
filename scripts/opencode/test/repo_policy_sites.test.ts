import { describe, expect, test } from "bun:test";
import {
  ensureAutomergeAfterPush,
  handleAutomergeLabelChange,
  scheduleAutomergeForPr,
} from "../src/automerge.ts";
import { IGNORE_CONFLICTS_SETTINGS_UNREADABLE, loadIgnoreConflictsAuthors } from "../src/ignore_conflicts.ts";
import type { IssueApi } from "../src/ports.ts";
import { shouldEnqueuePushConflicts } from "../src/push_webhook.ts";
import { invalidHeadSettingsFailure } from "../src/review.ts";
import { loadTakeoverAuthors } from "../src/takeover.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makePR, makePushPayload } from "./fixtures.ts";

function throwingFileApi(overrides: Partial<IssueApi> = {}) {
  const refs: string[] = [];
  const notes: string[] = [];
  const api = makeIssueApi({
    getRepoFile: async (_owner: string, _repo: string, _path: string, ref: string) => {
      refs.push(ref);
      throw new Error("boom");
    },
    createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => {
      notes.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner: string, _repo: string, _id: number, body: string) => {
      notes.push(body);
      return makeComment({ body });
    },
    ...overrides,
  });
  return { api, refs, notes };
}

describe("repo policy fail-closed sites on unreadable settings", () => {
  test("scheduleAutomergeForPr posts the unreadable note and schedules nothing", async () => {
    const { api, notes } = throwingFileApi();
    const logs: string[] = [];
    const result = await scheduleAutomergeForPr({
      api,
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      baseBranch: "main",
      automergeRepos: [],
      botUsername: "jumi",
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ scheduled: false });
    expect(notes.some((body) => body.includes("could not be read"))).toBe(true);
    expect(api.callsTo("scheduleAutoMerge")).toHaveLength(0);
    expect(logs.some((m) => m.includes("unreadable"))).toBe(true);
  });

  test("ensureAutomergeAfterPush restore path logs and returns on unreadable", async () => {
    const { api, notes } = throwingFileApi();
    const logs: string[] = [];
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "github",
      owner: "o",
      repo: "r",
      prNumber: 7,
      wasScheduled: true,
      automergeRepos: [],
      botUsername: "jumi",
      log: (m) => logs.push(m),
    });
    expect(logs.some((m) => m.includes("automerge settings unreadable"))).toBe(true);
    expect(notes).toEqual([]);
  });

  test("ensureAutomergeAfterPush gitea label path logs and returns on unreadable", async () => {
    const { api, notes } = throwingFileApi();
    const logs: string[] = [];
    await ensureAutomergeAfterPush({
      api,
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      wasScheduled: false,
      automergeRepos: [],
      botUsername: "jumi",
      log: (m) => logs.push(m),
    });
    expect(logs.some((m) => m.includes("automerge settings unreadable"))).toBe(true);
    expect(notes).toEqual([]);
  });

  test("handleAutomergeLabelChange returns none on unreadable", async () => {
    const { api } = throwingFileApi();
    const logs: string[] = [];
    const result = await handleAutomergeLabelChange({
      api,
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      baseBranch: "main",
      automergeRepos: [],
      botUsername: "jumi",
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ action: "none" });
    expect(logs.some((m) => m.includes("unreadable"))).toBe(true);
  });

  test("loadIgnoreConflictsAuthors returns undefined on unreadable", async () => {
    const { api } = throwingFileApi();
    const logs: string[] = [];
    expect(await loadIgnoreConflictsAuthors(api, "o", "r", "main", (m) => logs.push(m))).toBeUndefined();
    expect(logs.some((m) => m.includes("unreadable"))).toBe(true);
  });

  test("push conflicts skip closed on unreadable authors", async () => {
    const { api } = throwingFileApi();
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      {
        giteaUrl: "https://gitea.kirmanak.stream",
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "jumi",
      },
      api
    );
    expect(decision).toEqual({ type: "skip", reason: IGNORE_CONFLICTS_SETTINGS_UNREADABLE });
  });
});

describe("repo policy ref variants", () => {
  test("automerge label change reads the base branch", async () => {
    const refs: string[] = [];
    const api = makeIssueApi({
      getPR: async (_owner: string, _repo: string, index: number) =>
        makePR({ number: index, labels: ["no-automerge"] as never }),
      getRepoFile: async (_owner: string, _repo: string, _path: string, ref: string) => {
        refs.push(ref);
        return { found: true, content: "automerge: true\n" };
      },
      cancelAutoMerge: async () => true,
    });
    const result = await handleAutomergeLabelChange({
      api,
      forgeKind: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      baseBranch: "my-base",
      automergeRepos: [],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ action: "cancelled" });
    expect(refs).toEqual(["my-base"]);
  });

  test("takeover authors read the default branch", async () => {
    const refs: string[] = [];
    const api = makeIssueApi({
      getRepoFile: async (_owner: string, _repo: string, _path: string, ref: string) => {
        refs.push(ref);
        return { found: true, content: "takeover_authors: [alice]\n" };
      },
    });
    expect(await loadTakeoverAuthors(api, "o", "r", "main")).toEqual(["alice"]);
    expect(refs).toEqual(["main"]);
  });

  test("head settings failure reads the head SHA", async () => {
    const refs: string[] = [];
    const headSha = "deadbeef".repeat(5).slice(0, 40);
    const api = makeIssueApi({
      getRepoFile: async (_owner: string, _repo: string, _path: string, ref: string) => {
        refs.push(ref);
        return { found: true, content: "mode: full\n" };
      },
    });
    const failure = await invalidHeadSettingsFailure({
      api,
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha,
      baseBranch: "main",
      changedFiles: [{ filename: ".jumi.yml" }],
      log: () => undefined,
    });
    expect(failure).toBeUndefined();
    expect(refs).toEqual([headSha]);
  });
});
