import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUOTA_STUCK_TEXT } from "../src/quota.ts";
import {
  makeReplayReadOnly,
  parseReplayCases,
  REPLAY_WRITE_METHODS,
  type ReplayReadApi,
  ReplayWriteBlockedError,
  runReplay,
} from "../src/replay.ts";
import type { ReviewApi } from "../src/review.ts";
import { emptyCiMethods, makeBranch, makeFile, makeIssue, makePR, makeRepo, makeUser } from "./fixtures.ts";

const REPLAY_HEAD_SHA = "d90b7289701097dae3ffa3dc0ccdc348be552697";
const REPLAY_BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeCountingApi(overrides: Partial<ReviewApi> = {}): { api: ReviewApi; writes: Record<string, number> } {
  const writes: Record<string, number> = {};
  for (const method of REPLAY_WRITE_METHODS) writes[method] = 0;
  const count = (method: string) => {
    writes[method] = (writes[method] ?? 0) + 1;
  };
  const api: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async (_owner, _repo, prNumber) =>
      makePR({
        number: prNumber,
        head: makeBranch({ sha: REPLAY_HEAD_SHA }),
        base: makeBranch({ label: "kirmanak:main", ref: "main", sha: REPLAY_BASE_SHA }),
      }),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async () => {
      count("createIssueComment");
      throw new Error("replay must not create comments");
    },
    updateIssueComment: async () => {
      count("updateIssueComment");
      throw new Error("replay must not update comments");
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => {
      count("createPullReview");
      throw new Error("replay must not create reviews");
    },
    submitPullReview: async () => {
      count("submitPullReview");
      throw new Error("replay must not submit reviews");
    },
    resolvePullComment: async () => {
      count("resolvePullComment");
      throw new Error("replay must not resolve");
    },
    unresolvePullComment: async () => {
      count("unresolvePullComment");
      throw new Error("replay must not unresolve");
    },
    dismissPullReview: async () => {
      count("dismissPullReview");
      throw new Error("replay must not dismiss");
    },
    createCommitStatus: async () => {
      count("createCommitStatus");
      throw new Error("replay must not post status");
    },
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  } as ReviewApi;
  return { api, writes };
}

const RUNNERS = [
  { name: "fake-a", type: "opencode", model: "fake/model-a" },
  { name: "fake-b", type: "opencode", model: "fake/model-b" },
] as const;

describe("replay", () => {
  test("replay path cannot reach any forge write call", async () => {
    const { api, writes } = makeCountingApi();
    const readOnly = makeReplayReadOnly(api);
    for (const method of REPLAY_WRITE_METHODS) {
      expect(() => (readOnly as unknown as Record<string, () => void>)[method]?.()).toThrow(ReplayWriteBlockedError);
    }
    const workdirRoot = await mkdtemp(join(tmpdir(), "jumi-replay-root-"));
    const outDir = await mkdtemp(join(tmpdir(), "jumi-replay-out-"));
    try {
      const cases = parseReplayCases([
        { id: "case-a", owner: "kirmanak", repo: "demo", prNumber: 7 },
        { id: "case-b", owner: "kirmanak", repo: "demo", prNumber: 8 },
      ]);
      const records = await runReplay({
        api: readOnly,
        cases,
        runners: [...RUNNERS],
        outDir,
        workdirRoot,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "read-only",
        botUsername: "jumi",
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return REPLAY_HEAD_SHA;
          return "";
        },
        workspacePreparer: async () => undefined,
        createWorkspace: async (root) => mkdtemp(join(root, "ws-")),
        engineForRunner: (runner) => async (opts) => {
          await writeFile(
            join(opts.workdir, "JUMI_REVIEW.md"),
            `src/demo.ts:1: 🔴 bug: boom on ${runner.name}.\n<!-- jumi-check: failure -->`
          );
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(records).toHaveLength(4);
      for (const record of records) {
        expect(record.verdict).toBe("failure");
        expect(record.findings).toContain("boom");
        expect(record.findingsCount).toBe(1);
        expect(record.runnerStamp).toContain("fake/model-");
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
      }
      for (const method of REPLAY_WRITE_METHODS) expect(writes[method]).toBe(0);
      const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(4);
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("replay source never calls forge write or publish helpers", async () => {
    const source = await readFile(new URL("../src/replay.ts", import.meta.url), "utf8");
    for (const method of REPLAY_WRITE_METHODS) {
      expect(source).not.toContain(`.${method}(`);
    }
    for (const banned of ["publishReviewResult", "postReviewStatus", "upsertStuck", "markReviewQuota"]) {
      expect(source).not.toContain(banned);
    }
    // No git push/edit path: the only git entry points are clone/fetch/checkout helpers.
    expect(source).not.toContain('"push"');
    expect(source).not.toContain("'push'");
  });

  test("quota and skip are recorded rather than retried", async () => {
    const quotaApi = makeCountingApi();
    const readOnly = makeReplayReadOnly(quotaApi.api);
    const workdirRoot = await mkdtemp(join(tmpdir(), "jumi-replay-quota-"));
    const outDir = await mkdtemp(join(tmpdir(), "jumi-replay-quota-out-"));
    try {
      let calls = 0;
      const records = await runReplay({
        api: readOnly,
        cases: parseReplayCases([{ id: "quota-case", owner: "kirmanak", repo: "demo", prNumber: 7 }]),
        runners: [{ name: "fake-a", type: "opencode", model: "fake/model-a" }],
        outDir,
        workdirRoot,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "read-only",
        botUsername: "jumi",
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return REPLAY_HEAD_SHA;
          return "";
        },
        workspacePreparer: async () => undefined,
        createWorkspace: async (root) => mkdtemp(join(root, "ws-")),
        engineForRunner: () => async () => {
          calls++;
          return { status: "stuck", message: "FreeUsageLimitError: quota hit" };
        },
        logger: () => undefined,
      });
      expect(calls).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0].verdict).toBe("skip");
      expect(records[0].skipReason).toBe(QUOTA_STUCK_TEXT);
      expect(records[0].quota).toBe(true);
      for (const method of REPLAY_WRITE_METHODS) expect(quotaApi.writes[method]).toBe(0);
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("closed PR records a skip without running the engine", async () => {
    const { api, writes } = makeCountingApi({
      getPR: async (_owner, _repo, prNumber) => makePR({ number: prNumber, state: "closed" as const }),
    });
    const readOnly: ReplayReadApi = makeReplayReadOnly(api);
    const workdirRoot = await mkdtemp(join(tmpdir(), "jumi-replay-skip-"));
    const outDir = await mkdtemp(join(tmpdir(), "jumi-replay-skip-out-"));
    try {
      let calls = 0;
      const records = await runReplay({
        api: readOnly,
        cases: parseReplayCases([{ id: "closed-case", owner: "kirmanak", repo: "demo", prNumber: 7 }]),
        runners: [{ name: "fake-a", type: "opencode", model: "fake/model-a" }],
        outDir,
        workdirRoot,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "read-only",
        botUsername: "jumi",
        engineForRunner: () => async () => {
          calls++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(calls).toBe(0);
      expect(records).toHaveLength(1);
      expect(records[0].verdict).toBe("skip");
      expect(records[0].skipReason).toContain("closed");
      for (const method of REPLAY_WRITE_METHODS) expect(writes[method]).toBe(0);
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("case files accept prNumber or pinned shas, never private paths", async () => {
    expect(parseReplayCases([{ owner: "o", repo: "r", prNumber: 12 }])[0]).toMatchObject({
      owner: "o",
      repo: "r",
      prNumber: 12,
    });
    expect(
      parseReplayCases({
        cases: [{ id: "s", owner: "o", repo: "r", baseSha: "abc1234", headSha: "def5678", note: "n" }],
      })[0]
    ).toMatchObject({ id: "s", baseSha: "abc1234", headSha: "def5678", note: "n" });
    expect(() => parseReplayCases([{ owner: "o", repo: "r" }])).toThrow();
    expect(() => parseReplayCases([{ owner: "o", repo: "r", prNumber: 0 }])).toThrow();
    expect(() => parseReplayCases([{ owner: "o", repo: "r", baseSha: "abc", headSha: "zzz" }])).toThrow();
    expect(makeUser).toBeDefined();
  });
});
