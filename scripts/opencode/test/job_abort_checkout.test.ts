import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneShotWorkspacePreparer, runOneShotJob } from "../src/job.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { checkoutPullRequestWorkspace, type GitRunner } from "../src/workspace.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeFile, makeJob, makeWorkerConfig } from "./fixtures.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const GITEA_URL = "https://gitea.kirmanak.stream";

function oneShotRepo() {
  return {
    owner: { login: "kirmanak" },
    name: "demo",
    full_name: "kirmanak/demo",
    clone_url: `${GITEA_URL}/kirmanak/demo.git`,
  };
}

function oneShotPr() {
  return {
    number: 7,
    head: { sha: HEAD_SHA, ref: "feature" },
    base: { sha: BASE_SHA, ref: "main" },
  };
}

function checkoutRepo() {
  return {
    ...oneShotRepo(),
    html_url: `${GITEA_URL}/kirmanak/demo`,
    owner: { login: "kirmanak" },
  };
}

function checkoutPr() {
  const repo = checkoutRepo();
  return {
    number: 7,
    head: { ref: "feature", sha: HEAD_SHA, repo: { full_name: repo.full_name, clone_url: repo.clone_url } },
    base: { ref: "main", sha: BASE_SHA, repo: { full_name: repo.full_name, clone_url: repo.clone_url } },
  };
}

/** Fake `git` that blocks forever with a helper in its process group. */
const BLOCKING_GIT = `#!/bin/sh
printf '%s\\n' "$$" >> "$HOME/git-pids.log"
sleep 60 &
printf '%s\\n' "$!" >> "$HOME/git-pids.log"
printf 'git %s\\n' "$*" >> "$HOME/git-args.log"
wait
`;

/**
 * Fake `git` that emulates successful clones and blocks only on the PR-ref
 * fetch, so the abort lands after the earlier steps completed. `clone --bare`
 * creates a usable bare mirror skeleton; plain clones create the target dir.
 */
const PR_FETCH_BLOCKING_GIT = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$HOME/git-args.log"
case "$*" in
*refs/pull/*)
printf '%s\\n' "$$" >> "$HOME/git-pids.log"
sleep 60 &
printf '%s\\n' "$!" >> "$HOME/git-pids.log"
wait
;;
esac
last=""
for arg in "$@"; do last="$arg"; done
case "$*" in
*clone*--bare*)
mkdir -p "$last/objects" "$last/refs"
printf 'ref: refs/heads/main\\n' > "$last/HEAD"
printf '[core]\\n\\tbare = true\\n' > "$last/config"
;;
*clone*)
mkdir -p "$last"
;;
esac
exit 0
`;

async function withAbortFakeGit(script: string, run: (ctx: { home: string }) => Promise<void>): Promise<void> {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const binDir = await mkdtemp(join(tmpdir(), "jumi-abort-git-"));
  const home = await mkdtemp(join(tmpdir(), "jumi-abort-home-"));
  try {
    await writeFile(join(binDir, "git"), script);
    await chmod(join(binDir, "git"), 0o755);
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    process.env.HOME = home;
    await run({ home });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

async function readPidLog(path: string): Promise<number[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const pids = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  return [...new Set(pids)];
}

async function pidIsLive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[0];
    return state !== "Z" && state !== "X" && state !== "x";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForPids(path: string, count: number, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids: number[] = [];
  while (Date.now() < deadline) {
    pids = await readPidLog(path);
    if (pids.length >= count) return pids;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids;
}

async function waitForAllGone(pids: number[], timeoutMs = 3000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let live: number[] = [];
  do {
    live = [];
    for (const pid of pids) {
      if (await pidIsLive(pid)) live.push(pid);
    }
    if (live.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return live;
}

const hasSetsid = Boolean(Bun.which("setsid"));
const itSetsid = hasSetsid ? test : test.skip;

async function stageBareClone(args: string[]): Promise<void> {
  const gitArgs = stripConfig(args);
  if (gitArgs[0] === "clone" && gitArgs[1] === "--bare") {
    const target = gitArgs.at(-1) ?? "";
    await mkdir(join(target, "objects"), { recursive: true });
    await mkdir(join(target, "refs"), { recursive: true });
    await writeFile(join(target, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(target, "config"), "[core]\n\tbare = true\n");
  }
}

function stripConfig(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function checkoutFixture() {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: workspace options accept the port-shaped repo/PR.
    repo: checkoutRepo() as any,
    // biome-ignore lint/suspicious/noExplicitAny: workspace options accept the port-shaped repo/PR.
    pr: checkoutPr() as any,
  };
}

describe("abort signal threading", () => {
  test("checkout forwards abortSignal to every git call, including mirror runs", async () => {
    const { repo, pr } = checkoutFixture();
    const root = await mkdtemp(join(tmpdir(), "jumi-abort-thread-"));
    try {
      const workdir = join(root, "review-7");
      const controller = new AbortController();
      const signals: Array<AbortSignal | undefined> = [];
      const gitRunner: GitRunner = async (args, opts) => {
        signals.push(opts.signal);
        await stageBareClone(args);
        const gitArgs = stripConfig(args);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return HEAD_SHA;
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return BASE_SHA;
        return "";
      };
      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: GITEA_URL,
        username: "jumi",
        token: "bot-token",
        gitRunner,
        abortSignal: controller.signal,
      });
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) expect(signal).toBe(controller.signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checkout omits the signal when none is supplied", async () => {
    const { repo, pr } = checkoutFixture();
    const root = await mkdtemp(join(tmpdir(), "jumi-abort-nosig-"));
    try {
      const workdir = join(root, "review-7");
      const seen: Array<"signal" | "none"> = [];
      const gitRunner: GitRunner = async (args, opts) => {
        seen.push(opts.signal ? "signal" : "none");
        await stageBareClone(args);
        const gitArgs = stripConfig(args);
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return HEAD_SHA;
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return BASE_SHA;
        return "";
      };
      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr,
        giteaUrl: GITEA_URL,
        username: "jumi",
        token: "bot-token",
        gitRunner,
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry === "none")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("oneShotWorkspacePreparer rejects a pre-aborted signal without cloning", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-abort-pre-"));
    try {
      const workdir = join(root, "workdir");
      const err = await oneShotWorkspacePreparer(
        {
          workdir,
          repo: oneShotRepo(),
          pr: oneShotPr(),
          giteaUrl: GITEA_URL,
          username: "jumi",
          token: "bot-token",
          abortSignal: AbortSignal.abort(),
        },
        {}
      ).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(err instanceof Error && err.name).toBe("AbortError");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("abort during workspace preparation kills the owned git group", () => {
  itSetsid(
    "one-shot clone abort rejects AbortError and leaves no group member running",
    async () => {
      await withAbortFakeGit(BLOCKING_GIT, async ({ home }) => {
        const root = await mkdtemp(join(tmpdir(), "jumi-abort-oneshot-"));
        try {
          const workdir = join(root, "workdir");
          const controller = new AbortController();
          const pending = oneShotWorkspacePreparer(
            {
              workdir,
              repo: { ...oneShotRepo(), clone_url: "https://gitea.example.test/owner/repo.git" },
              pr: oneShotPr(),
              giteaUrl: "https://gitea.example.test",
              username: "jumi",
              token: "bot-token",
              abortSignal: controller.signal,
            },
            {}
          );
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          controller.abort();
          const err = await pending.then(
            () => null,
            (caught: unknown) => caught
          );
          expect(err instanceof Error && err.name).toBe("AbortError");
          expect(await waitForAllGone(pids)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    },
    15_000
  );

  itSetsid(
    "one-shot PR-ref fetch abort rejects AbortError and leaves no group member running",
    async () => {
      await withAbortFakeGit(PR_FETCH_BLOCKING_GIT, async ({ home }) => {
        const root = await mkdtemp(join(tmpdir(), "jumi-abort-prfetch-"));
        try {
          const workdir = join(root, "workdir");
          const controller = new AbortController();
          const pending = oneShotWorkspacePreparer(
            {
              workdir,
              repo: { ...oneShotRepo(), clone_url: "https://gitea.example.test/owner/repo.git" },
              pr: oneShotPr(),
              giteaUrl: "https://gitea.example.test",
              username: "jumi",
              token: "bot-token",
              abortSignal: controller.signal,
            },
            {}
          );
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          const argsLog = await readFile(join(home, "git-args.log"), "utf8");
          expect(argsLog).toContain("refs/pull/");
          controller.abort();
          const err = await pending.then(
            () => null,
            (caught: unknown) => caught
          );
          expect(err instanceof Error && err.name).toBe("AbortError");
          expect(await waitForAllGone(pids)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    },
    15_000
  );

  itSetsid(
    "mirror clone abort rejects AbortError and leaves no group member running",
    async () => {
      await withAbortFakeGit(BLOCKING_GIT, async ({ home }) => {
        const root = await mkdtemp(join(tmpdir(), "jumi-abort-mirror-"));
        try {
          const { repo, pr } = checkoutFixture();
          const workdir = join(root, "review-7");
          const controller = new AbortController();
          const pending = checkoutPullRequestWorkspace({
            workdir,
            repo,
            pr,
            giteaUrl: GITEA_URL,
            username: "jumi",
            token: "bot-token",
            abortSignal: controller.signal,
          });
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          const argsLog = await readFile(join(home, "git-args.log"), "utf8");
          expect(argsLog).toContain("clone --bare");
          controller.abort();
          const err = await pending.then(
            () => null,
            (caught: unknown) => caught
          );
          expect(err instanceof Error && err.name).toBe("AbortError");
          expect(await waitForAllGone(pids)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    },
    15_000
  );

  itSetsid(
    "checkout PR-ref fetch abort rejects AbortError and leaves no group member running",
    async () => {
      await withAbortFakeGit(PR_FETCH_BLOCKING_GIT, async ({ home }) => {
        const root = await mkdtemp(join(tmpdir(), "jumi-abort-corefetch-"));
        try {
          const { repo, pr } = checkoutFixture();
          const workdir = join(root, "review-7");
          const controller = new AbortController();
          const pending = checkoutPullRequestWorkspace({
            workdir,
            repo,
            pr,
            giteaUrl: GITEA_URL,
            username: "jumi",
            token: "bot-token",
            abortSignal: controller.signal,
          });
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          const argsLog = await readFile(join(home, "git-args.log"), "utf8");
          expect(argsLog).toContain("refs/pull/");
          controller.abort();
          const err = await pending.then(
            () => null,
            (caught: unknown) => caught
          );
          expect(err instanceof Error && err.name).toBe("AbortError");
          expect(await waitForAllGone(pids)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    },
    15_000
  );
});

function abortReviewApi() {
  return makeReviewApi({
    getPR: async () => ({
      number: 7,
      title: "Add feature",
      body: "PR body",
      state: "open" as const,
      html_url: `${GITEA_URL}/kirmanak/demo/pulls/7`,
      user: { login: "alice" },
      head: {
        ref: "feature",
        sha: HEAD_SHA,
        repo: { full_name: "kirmanak/demo", clone_url: `${GITEA_URL}/kirmanak/demo.git` },
      },
      base: { ref: "main", sha: BASE_SHA },
      merged: false,
      created_at: "2026-05-23T00:00:00Z",
      updated_at: "2026-05-23T00:00:00Z",
    }),
    getPRFiles: async () => [makeFile()],
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  });
}

/**
 * No failure review or failure comment was posted. The `pending` "running"
 * status posted before workspace preparation is normal review startup, not
 * an abort artifact, so only `failure`/`error` states are forbidden.
 */
function expectNoFailurePosts(api: ReturnType<typeof abortReviewApi>): void {
  expect(api.callsTo("createPullReview")).toEqual([]);
  expect(api.callsTo("createIssueComment")).toEqual([]);
  expect(api.callsTo("updateIssueComment")).toEqual([]);
  for (const call of api.callsTo("createCommitStatus")) {
    const payload = call.args[3] as { state?: string } | undefined;
    expect(payload?.state).not.toBe("failure");
    expect(payload?.state).not.toBe("error");
  }
}

/** Unchanged `verifyRowSettled` rules, asserted against the row read back. */
function expectedExitFor(row: { state?: string; leasedBy?: string | null } | undefined, leasedBy: string): 0 | 1 {
  return row && row.state === "leased" && row.leasedBy === leasedBy ? 1 : 0;
}

describe("one-shot abort posts no failure and exits per the settled-row rules", () => {
  itSetsid(
    "clone abort settles queued, posts nothing, exits 0",
    async () => {
      await withAbortFakeGit(BLOCKING_GIT, async ({ home }) => {
        const store = new MemoryReviewJobStore();
        await store.enqueue(makeJob({ owner: "kirmanak", repo: "demo", prNumber: 7, headSha: HEAD_SHA }));
        const probe = await store.lease("probe", 60_000);
        expect(probe).toBeDefined();
        await store.releaseLease(probe!.id, "probe");
        const jobId = probe!.id;
        const leasedBy = "one-shot-abort-test";
        const api = abortReviewApi();
        let engineRan = false;
        const workspace = await mkdtemp(join(tmpdir(), "jumi-abort-job-"));
        const controller = new AbortController();
        try {
          const runPromise = runOneShotJob({
            store,
            jobId,
            engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
            workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
            // biome-ignore lint/suspicious/noExplicitAny: fake forge for the abort path.
            api: api as any,
            logger: () => undefined,
            abortSignal: controller.signal,
            leasedBy,
            engineExtras: {
              openCodeRunner: (async () => {
                engineRan = true;
                throw new Error("engine must not run after an abort");
              }) as never,
            },
          });
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          controller.abort();
          const result = await runPromise;
          expect(await waitForAllGone(pids)).toEqual([]);
          expect(engineRan).toBe(false);
          const row = await store.get(jobId);
          expect(row?.state).not.toBe("failed");
          // Unchanged verifyRowSettled rules: queued/terminal or no longer
          // owned permits exit 0; still leased to this token requires exit 1.
          const expected = expectedExitFor(row ?? undefined, leasedBy);
          expect(result.exitCode).toBe(expected);
          expect(row?.state).not.toBe("leased");
          expect(expected).toBe(0);
          expectNoFailurePosts(api);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      });
    },
    30_000
  );

  itSetsid(
    "PR-ref fetch abort posts nothing and exits per the settled-row rules",
    async () => {
      await withAbortFakeGit(PR_FETCH_BLOCKING_GIT, async ({ home }) => {
        const store = new MemoryReviewJobStore();
        await store.enqueue(makeJob({ owner: "kirmanak", repo: "demo", prNumber: 7, headSha: HEAD_SHA }));
        const probe = await store.lease("probe", 60_000);
        expect(probe).toBeDefined();
        await store.releaseLease(probe!.id, "probe");
        const jobId = probe!.id;
        const leasedBy = "one-shot-abort-fetch-test";
        const api = abortReviewApi();
        const workspace = await mkdtemp(join(tmpdir(), "jumi-abort-jobfetch-"));
        const controller = new AbortController();
        try {
          const runPromise = runOneShotJob({
            store,
            jobId,
            engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
            workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
            // biome-ignore lint/suspicious/noExplicitAny: fake forge for the abort path.
            api: api as any,
            logger: () => undefined,
            abortSignal: controller.signal,
            leasedBy,
            engineExtras: {
              openCodeRunner: (async () => {
                throw new Error("engine must not run after an abort");
              }) as never,
            },
          });
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          expect(await readFile(join(home, "git-args.log"), "utf8")).toContain("refs/pull/");
          controller.abort();
          const result = await runPromise;
          expect(await waitForAllGone(pids)).toEqual([]);
          const row = await store.get(jobId);
          expect(row?.state).not.toBe("failed");
          const expected = expectedExitFor(row ?? undefined, leasedBy);
          expect(result.exitCode).toBe(expected);
          expect(expected).toBe(0);
          expectNoFailurePosts(api);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      });
    },
    30_000
  );

  itSetsid(
    "an unsettled row still leased to this token exits 1, never 0",
    async () => {
      await withAbortFakeGit(BLOCKING_GIT, async ({ home }) => {
        const backing = new MemoryReviewJobStore();
        await backing.enqueue(makeJob({ owner: "kirmanak", repo: "demo", prNumber: 7, headSha: HEAD_SHA }));
        const probe = await backing.lease("probe", 60_000);
        expect(probe).toBeDefined();
        await backing.releaseLease(probe!.id, "probe");
        const jobId = probe!.id;
        const leasedBy = "one-shot-abort-unsettled-test";
        // The shutdown release path fails, so the row stays leased to this
        // token and the unchanged settled-row rules require exit 1.
        const store = new Proxy(backing, {
          get(target, prop, receiver) {
            if (prop === "releaseLease" || prop === "expireLease" || prop === "shutdownRelease") {
              return async () => {
                throw new Error("ledger release down");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as MemoryReviewJobStore;
        const api = abortReviewApi();
        const workspace = await mkdtemp(join(tmpdir(), "jumi-abort-jobun-"));
        const controller = new AbortController();
        try {
          const runPromise = runOneShotJob({
            store,
            jobId,
            engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
            workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
            // biome-ignore lint/suspicious/noExplicitAny: fake forge for the abort path.
            api: api as any,
            logger: () => undefined,
            abortSignal: controller.signal,
            leasedBy,
            engineExtras: {
              openCodeRunner: (async () => {
                throw new Error("engine must not run after an abort");
              }) as never,
            },
          });
          const pids = await waitForPids(join(home, "git-pids.log"), 2);
          expect(pids.length).toBeGreaterThanOrEqual(2);
          controller.abort();
          const result = await runPromise;
          expect(await waitForAllGone(pids)).toEqual([]);
          const row = await backing.get(jobId);
          expect(row?.state).toBe("leased");
          expect(row?.leasedBy).toBe(leasedBy);
          expect(result.exitCode).toBe(1);
          expect(row?.state).not.toBe("failed");
          expectNoFailurePosts(api);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      });
    },
    30_000
  );

  test("an injected preparer abort rejection exits 0 with no failure post", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ owner: "kirmanak", repo: "demo", prNumber: 7, headSha: HEAD_SHA }));
    const probe = await store.lease("probe", 60_000);
    expect(probe).toBeDefined();
    await store.releaseLease(probe!.id, "probe");
    const jobId = probe!.id;
    const leasedBy = "one-shot-abort-injected-test";
    const api = abortReviewApi();
    const seen: Array<AbortSignal | undefined> = [];
    const workspace = await mkdtemp(join(tmpdir(), "jumi-abort-jobinj-"));
    try {
      const abortErr = new Error("cancelled");
      abortErr.name = "AbortError";
      const result = await runOneShotJob({
        store,
        jobId,
        engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        // biome-ignore lint/suspicious/noExplicitAny: fake forge for the abort path.
        api: api as any,
        logger: () => undefined,
        leasedBy,
        engineExtras: {
          workspacePreparer: async (opts: { abortSignal?: AbortSignal }) => {
            seen.push(opts.abortSignal);
            throw abortErr;
          },
          openCodeRunner: (async () => {
            throw new Error("engine must not run after an abort");
          }) as never,
        },
      });
      // The job wrapper forwards its abort signal to injected preparers; an
      // injected preparer that ignores it keeps working (existing tests), and
      // an abort rejection follows the abort path, not the failure path.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(result.exitCode).toBe(0);
      const row = await store.get(jobId);
      expect(row?.state).not.toBe("failed");
      // `expireLease` keeps `state: "leased"` but clears the owner, so the
      // unchanged settled-row rules still permit exit 0: no longer owned.
      expect(row?.leasedBy).not.toBe(leasedBy);
      expectNoFailurePosts(api);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
