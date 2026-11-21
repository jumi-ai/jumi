import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReplayReadOnly, parseReplayCases, resolveReplayArtifactName, runReplay } from "../src/replay.ts";
import type { ReviewApi } from "../src/review.ts";
import { emptyCiMethods, makeBranch, makeFile, makeIssue, makePR, makeRepo } from "./fixtures.ts";

const PIN_BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PIN_HEAD_FIRST = "1111111111111111111111111111111111111111";
const PIN_HEAD_SECOND = "2222222222222222222222222222222222222222";

const PIN_RUNNERS = [
  { name: "fake-a", type: "opencode", model: "fake/model-a" },
  { name: "fake-b", type: "opencode", model: "fake/model-b" },
] as const;

function makePinBaseApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async (_owner, _repo, prNumber) =>
      makePR({
        number: prNumber,
        head: makeBranch({ sha: PIN_HEAD_FIRST }),
        base: makeBranch({ label: "kirmanak:main", ref: "main", sha: PIN_BASE_SHA }),
      }),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  } as ReviewApi;
}

describe("replay pinned inputs", () => {
  test("a head that moves between runner calls is resolved once per case", async () => {
    let prCalls = 0;
    let filesCalls = 0;
    const api = makePinBaseApi({
      getPR: async (_owner, _repo, prNumber) => {
        prCalls += 1;
        const head = prCalls === 1 ? PIN_HEAD_FIRST : PIN_HEAD_SECOND;
        return makePR({
          number: prNumber,
          head: makeBranch({ sha: head }),
          base: makeBranch({ label: "kirmanak:main", ref: "main", sha: PIN_BASE_SHA }),
        });
      },
      getPRFiles: async () => {
        filesCalls += 1;
        if (filesCalls === 1) {
          return [makeFile({ filename: "first.ts", patch: "@@ -1 +1 @@\n-FIRST_MARKER\n+FIRST_MARKER" })];
        }
        return [makeFile({ filename: "second.ts", patch: "@@ -1 +1 @@\n-SECOND_MARKER\n+SECOND_MARKER" })];
      },
    });
    const readOnly = makeReplayReadOnly(api);
    const workdirRoot = await mkdtemp(join(tmpdir(), "jumi-replay-pin-"));
    const outDir = await mkdtemp(join(tmpdir(), "jumi-replay-pin-out-"));
    try {
      const prompts = new Map<string, string>();
      const records = await runReplay({
        api: readOnly,
        cases: parseReplayCases([{ id: "pin-case", owner: "kirmanak", repo: "demo", prNumber: 7 }]),
        runners: [...PIN_RUNNERS],
        outDir,
        workdirRoot,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "read-only",
        botUsername: "jumi",
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return PIN_HEAD_FIRST;
          return "";
        },
        workspacePreparer: async () => undefined,
        createWorkspace: async (root) => mkdtemp(join(root, "ws-")),
        engineForRunner: (runner) => async (opts) => {
          prompts.set(runner.name, await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8"));
          await writeFile(
            join(opts.workdir, "JUMI_REVIEW.md"),
            `src/demo.ts:1: 🔴 bug: boom on ${runner.name}.\n<!-- jumi-check: failure -->`
          );
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(records).toHaveLength(2);
      expect(prCalls).toBe(1);
      expect(filesCalls).toBe(1);
      for (const record of records) {
        expect(record.baseSha).toBe(PIN_BASE_SHA);
        expect(record.headSha).toBe(PIN_HEAD_FIRST);
      }
      expect(prompts.size).toBe(2);
      for (const prompt of prompts.values()) {
        expect(prompt).toContain("FIRST_MARKER");
        expect(prompt).not.toContain("SECOND_MARKER");
      }
      const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
      const lines = jsonl.trim().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { baseSha: string; headSha: string };
        expect(parsed.baseSha).toBe(PIN_BASE_SHA);
        expect(parsed.headSha).toBe(PIN_HEAD_FIRST);
      }
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("sanitizing collisions produce distinct files while ordinary names stay readable", async () => {
    const api = makePinBaseApi();
    const readOnly = makeReplayReadOnly(api);
    const workdirRoot = await mkdtemp(join(tmpdir(), "jumi-replay-collide-"));
    const outDir = await mkdtemp(join(tmpdir(), "jumi-replay-collide-out-"));
    const collHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    try {
      const records = await runReplay({
        api: readOnly,
        cases: parseReplayCases([
          { id: "a/b", owner: "kirmanak", repo: "demo", baseSha: PIN_BASE_SHA, headSha: collHead },
          { id: "a:b", owner: "kirmanak", repo: "demo", baseSha: PIN_BASE_SHA, headSha: collHead },
          { id: "plain", owner: "kirmanak", repo: "demo", baseSha: PIN_BASE_SHA, headSha: collHead },
        ]),
        runners: [...PIN_RUNNERS],
        outDir,
        workdirRoot,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "read-only",
        botUsername: "jumi",
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return collHead;
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
      expect(records).toHaveLength(6);
      const entries = (await readdir(outDir)).filter((entry) => entry.endsWith(".md")).sort();
      expect(entries).toHaveLength(6);
      expect(new Set(entries).size).toBe(6);
      expect(entries).toContain("plain.fake-a.md");
      expect(entries).toContain("plain.fake-b.md");
      expect(entries).toContain("a_b.fake-a.md");
      expect(entries).toContain("a_b.fake-b.md");
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("artifact names keep the readable form and disambiguate only on collision", () => {
    const used = new Set<string>();
    expect(resolveReplayArtifactName("plain", "fake-a", used)).toBe("plain.fake-a.md");
    expect(resolveReplayArtifactName("a/b", "fake-a", used)).toBe("a_b.fake-a.md");
    const colliding = resolveReplayArtifactName("a:b", "fake-a", used);
    expect(colliding).not.toBe("a_b.fake-a.md");
    expect(colliding.startsWith("a_b.fake-a.")).toBe(true);
    expect(colliding.endsWith(".md")).toBe(true);
  });
});
